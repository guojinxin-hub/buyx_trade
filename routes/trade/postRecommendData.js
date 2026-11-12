/**
 * 推荐数据下单接口
 *
 * 业务逻辑：
 * 1. 根据当前时刻（hour）查询今日OverallRecModel表中的推荐数据
 * 2. 检查每个币种的推荐方向：
 *    - 同一方向 → 加入下单队列
 *    - 不同方向 → 加入平仓队列（先平仓再下单）
 * 3. 遍历每个激活的用户交易配置：
 *    - 对有持仓的冲突币种执行平仓
 *    - 过滤今日已交易币种
 *    - 对剩余币种执行下单
 *
 * @param {Object} req - Express请求对象（body: { hour })
 * @param {Object} res - Express响应对象
 * @returns {Promise<void>}
 */
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {isEmpty} from "lodash";
import {OverallRecModel, UserModel} from "buydip_scheme";
import moment from "moment";
import {formatResponse} from "../../dataUtils/formatResponse";
import {apiTrade, getUserPositions} from "../../dataUtils/apiTrade";
import {executeClosePositions} from "../../dataUtils/closePositions";
import {getLimitEntryPrice, LIMIT_ORDER_TTL_MS} from "../../dataUtils/limitEntryPrice";
import {isSameLimitPrice, prepareLimitEntryOrders} from "../../dataUtils/limitEntryManager";

// 同一时间只允许一轮下单：定时任务重试 / 手动触发并发时，
// 两条请求会在本地记录写入前同时通过去重校验，导致同币种重复挂单
let isRunning = false;

export const postRecommendData = async (req, res) => {
    if (isRunning) {
        console.log('上一轮下单仍在执行，跳过本次请求');
        return formatResponse(res, 200, 0, {}, '上一轮下单仍在执行，跳过');
    }
    isRunning = true;
    try {
        const { hour } = req.body || {};

        // 1. 根据当前时刻查询今日的推荐数据
        const query = {
            createdAt: {$gte: moment().startOf('day').toDate()}
        };
        if (hour !== undefined && hour !== null && hour !== '') {
            query.dateTime = Number(hour);
        }

        const todayRecommends = await OverallRecModel.find(query).lean();

        console.log(`查询到 ${todayRecommends.length} 条推荐数据（hour=${hour}）`);

        // 无数据则直接返回
        if (isEmpty(todayRecommends)) {
            return formatResponse(res, 200, 0, {}, '暂无推荐数据');
        }

        // 2. 构建币种方向映射表 {symbol: [directions]}
        const symbolDirectionMap = {};
        todayRecommends.forEach(item => {
            if (!symbolDirectionMap[item.symbol]) {
                symbolDirectionMap[item.symbol] = [];
            }
            symbolDirectionMap[item.symbol].push(item.direction);
        });

        const filteredRecommends = []; // 同一方向的推荐（可直接下单）
        const needCloseSymbols = [];   // 存在方向冲突的币种（需要先平仓）

        // 3. 检查每个币种的推荐方向
        for (const [symbol, directions] of Object.entries(symbolDirectionMap)) {
            const uniqueDirections = [...new Set(directions)];

            if (uniqueDirections.length === 1) {
                // 同一方向，加入下单队列
                const recommend = todayRecommends.find(r => r.symbol === symbol && r.direction === uniqueDirections[0]);
                filteredRecommends.push(recommend);
            } else {
                // 不同方向，加入平仓队列
                needCloseSymbols.push(symbol);
                console.log(`币种 ${symbol} 存在不同方向推荐，需要先平仓`);
            }
        }

        // 3.5 委托单：engine 已按策略写入委托形式
        //     - 限价策略：entryType=limit，X/J/L 做多=1D MA20×买入系数、做空=1D MA20×卖出系数，C 取4日高低中值
        //     - 顺势策略（fundFlowTrend）：entryType=market，允许突破入场
        const orderRecommends = [];
        for (const recommend of filteredRecommends) {
            const entryType = recommend.entryType === 'limit' ? 'limit' : 'market';

            if (entryType === 'market') {
                orderRecommends.push({...recommend, entryType, limitPrice: null});
                continue;
            }

            let limitPrice = Number(recommend.orderPrice);
            if (!limitPrice || limitPrice <= 0) {
                // 兜底：历史推荐没有写入委托价时按同一公式补算
                limitPrice = await getLimitEntryPrice(recommend.symbol, {
                    direction: recommend.direction,
                    strategy: recommend.strategy
                });
            }
            if (!limitPrice) {
                console.warn(`币种 ${recommend.symbol} 为限价委托但缺少有效委托价，跳过下单`);
                continue;
            }
            orderRecommends.push({...recommend, entryType, limitPrice});
        }
        console.log(`委托单生成完成：${orderRecommends.map(r => `${r.symbol}(${r.direction},${r.entryType}${r.limitPrice ? '@' + r.limitPrice.toFixed(6) : ''})`).join(', ') || '无'}`);

        // 4. 获取所有激活的用户交易配置
        let options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
        }).lean();

        // 4.1 跳过用户已被删除的"孤儿"配置：
        //     这类配置仍 isActive，会继续下单，表现为"自己账户里冒出其它杠杆/金额的单子"
        const optionUserIds = [...new Set(options.map(option => String(option.userId)))];
        const aliveUsers = await UserModel.find({_id: {$in: optionUserIds}}, {_id: 1}).lean();
        const aliveUserIds = new Set(aliveUsers.map(user => String(user._id)));
        const orphanOptions = options.filter(option => !aliveUserIds.has(String(option.userId)));
        if (orphanOptions.length > 0) {
            console.warn(`跳过 ${orphanOptions.length} 个用户已不存在的交易配置: ${orphanOptions.map(o => `${o.userId}(${o.belong})`).join(', ')}`);
            options = options.filter(option => aliveUserIds.has(String(option.userId)));
        }

        // 5. 遍历每个用户执行交易
        for (const option of options) {
            if (!isEmpty(option)) {
                // 5.1 处理方向冲突的币种：先平仓
                if (needCloseSymbols.length > 0) {
                    console.log(`用户 ${option.userId} 有 ${needCloseSymbols.length} 个币种需要平仓`);
                    try {
                        const positions = await getUserPositions(option);
                        // 筛选有实际持仓的币种
                        const closeSymbols = needCloseSymbols.filter(symbol => {
                            const position = positions.find(p => p.symbol === symbol);
                            return position && parseFloat(position.size) !== 0;
                        });

                        // 执行平仓
                        if (closeSymbols.length > 0) {
                            const closeTradeData = closeSymbols.map(symbol => ({ symbol }));
                            await executeClosePositions({ tradeData: closeTradeData, userOptions: option });
                            console.log(`用户 ${option.userId} 已平仓 ${closeSymbols.length} 个币种: ${closeSymbols.join(', ')}`);
                        }
                    } catch (error) {
                        console.error(`获取用户 ${option.userId} 持仓信息或平仓失败:`, error.message);
                    }
                }

                // 5.2 获取用户今日已交易的币种（去重，必须按交易所隔离）
                // 注意：saveTradeRecord 写入的是 userOptions.userId（users 表 ObjectId）与 exchange(小写)，此处必须一致
                // 若不带 exchange，同一用户多交易所会互相"吃掉"信号：靠前处理的配置把币种占完，
                // 靠后处理的配置（如 Binance/Bybit）当日再也拿不到该币种，表现为"无法入场"
                const tradedSymbols = await TradeRecordModel.find({
                    userId: option.userId,
                    exchange: option.belong.toLowerCase(),
                    createdAt: {$gte: moment().startOf('day').toDate()},
                }).distinct('symbol');

                // 5.3 过滤掉今日已交易的币种，以及已有同价未成交限价挂单的币种
                //     限价单可能跨日仍挂着（24小时有效）
                //     注意：只有"同价"才跳过；价格已变化的由 prepareLimitEntryOrders 撤旧挂新
                const pendingLimits = await TradeRecordModel.find({
                    userId: option.userId,
                    exchange: option.belong.toLowerCase(),
                    orderType: 'limit',
                    entryFilled: false,
                    status: 'pending',
                    createdAt: {$gte: moment().subtract(LIMIT_ORDER_TTL_MS, 'milliseconds').toDate()},
                }).lean();

                const pendingLimitPriceMap = {};
                pendingLimits.forEach(record => {
                    if (!pendingLimitPriceMap[record.symbol]) pendingLimitPriceMap[record.symbol] = [];
                    pendingLimitPriceMap[record.symbol].push(record.limitPrice);
                });

                const tradeData = orderRecommends.filter(item => {
                    if (tradedSymbols.includes(item.symbol)) return false;
                    if (item.entryType !== 'limit') return true;
                    const pendingPrices = pendingLimitPriceMap[item.symbol] || [];
                    return !pendingPrices.some(price => isSameLimitPrice(price, item.limitPrice));
                });

                if (pendingLimits.length > 0) {
                    console.log(`用户 ${option.userId} 仍有未成交限价单: ${pendingLimits.map(r => `${r.symbol}@${r.limitPrice}`).join(', ')}`);
                }

                console.log(`用户 ${option.userId} 今日已交易币种: ${tradedSymbols.join(', ') || '无'}，待下单: ${tradeData.length}个`);

                // 5.4 限价委托：同一账户同一币种同时只保留一条挂单
                //     同价 -> 保留交易所旧单；异价 -> 先撤旧单再挂新单（跨配置共用同一账户也能撤到）
                let finalTradeData = tradeData;
                const limitRecommends = tradeData.filter(item => item.entryType === 'limit');
                if (!isEmpty(limitRecommends)) {
                    const placeLimits = await prepareLimitEntryOrders(option, limitRecommends);
                    const placeSymbols = new Set(placeLimits.map(item => item.symbol));
                    finalTradeData = tradeData.filter(item =>
                        item.entryType !== 'limit' || placeSymbols.has(item.symbol)
                    );
                }

                // 5.5 执行下单
                if (!isEmpty(finalTradeData)) {
                    await apiTrade({userOptions: option, tradeData: finalTradeData});
                    console.log(`用户 ${option.userId} 下单完成，共 ${finalTradeData.length} 个币种`);
                } else {
                    console.log(`用户 ${option.userId} 今日已完成所有推荐币种的交易，跳过`);
                }
            }
        }

        return formatResponse(res, 200, 0, {}, 'success')
    } catch (e) {
        console.log(e, e.message)
        return formatResponse(res, 500, 1, {}, '服务器错误')
    } finally {
        isRunning = false;
    }
}
