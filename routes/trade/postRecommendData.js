/**
 * 二次推荐下单接口
 * 
 * 业务逻辑：
 * 1. 查询今日未下单的二次推荐数据（SecondaryRecommendModel）
 * 2. 检查每个币种的推荐方向：
 *    - 同一方向 → 加入下单队列
 *    - 不同方向 → 加入平仓队列（先平仓再下单）
 * 3. 遍历每个激活的用户交易配置：
 *    - 对有持仓的冲突币种执行平仓
 *    - 过滤今日已交易币种
 *    - 对剩余币种执行下单
 *    - 更新二次推荐状态为已下单
 * 
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @returns {Promise<void>}
 */
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {isEmpty} from "lodash";
import {SecondaryRecommendModel} from "buydip_scheme";
import moment from "moment";
import {formatResponse} from "../../dataUtils/formatResponse";
import {apiTrade, getUserPositions} from "../../dataUtils/apiTrade";
import {executeClosePositions} from "../../dataUtils/closePositions";

export const postRecommendData = async (req, res) => {
    try {
        // 1. 查询今日未下单的二次推荐数据
        const todayRecommends = await SecondaryRecommendModel.find({
            createdAt: {$gte: moment().startOf('day').toDate()},
            isTraded: false
        }).lean();

        console.log(`查询到 ${todayRecommends.length} 条未下单的二次推荐数据`);

        // 无数据则直接返回
        if (isEmpty(todayRecommends)) {
            return formatResponse(res, 200, 0, {}, '暂无未下单的二次推荐数据');
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

        // 4. 获取所有激活的用户交易配置
        const options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
        }).lean();

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

                // 5.2 获取用户今日已交易的币种（去重）
                const tradedSymbols = await TradeRecordModel.find({
                    userId: option._id,
                    createdAt: {$gte: moment().startOf('day').toDate()},
                }).distinct('symbol');

                // 5.3 过滤掉今日已交易的币种
                const tradeData = filteredRecommends.filter(item => !tradedSymbols.includes(item.symbol));
                
                console.log(`用户 ${option.userId} 今日已交易币种: ${tradedSymbols.join(', ') || '无'}，待下单: ${tradeData.length}个`);

                // 5.4 执行下单
                if (!isEmpty(tradeData)) {
                    await apiTrade({userOptions: option, tradeData});
                    
                    // 5.5 更新二次推荐状态为已下单
                    await SecondaryRecommendModel.updateMany(
                        {symbol: {$in: tradeData.map(item => item.symbol)}},
                        {$set: {isTraded: true}}
                    );
                    console.log(`用户 ${option.userId} 下单完成，已更新 ${tradeData.length} 条二次推荐数据的交易状态`);
                } else {
                    console.log(`用户 ${option.userId} 今日已完成所有推荐币种的交易，跳过`);
                }
            }
        }

        return formatResponse(res, 200, 0, {}, 'success')
    } catch (e) {
        console.log(e, e.message)
        return formatResponse(res, 500, 1, {}, '服务器错误')
    }
}