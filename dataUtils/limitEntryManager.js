/**
 * 限价委托单管理器（定时任务，默认每 60 秒）
 *
 * 背景：engine 把推荐改成"带价格+方向的委托单"——
 *   - 逆势策略（priceTrend / continuousFundFlow / cci）：entryType=limit，不追突破，挂最近4日高低中值
 *   - 顺势策略（fundFlowTrend / marketSignal）：entryType=market，允许突破入场（本管理器不处理）
 *
 * 限价单可能长时间不成交，因此需要独立管理：
 *
 * 1. 成交后补挂止盈止损
 *    - Gate / Binance：下单接口不支持随限价单附带止盈止损（无持仓时交易所拒绝平仓条件单），
 *      必须在检测到持仓后按实际持仓均价补挂
 *    - OKX / Bybit / Bitget：下单时已附带止盈止损（成交后自动生效），这里只做成交状态登记
 * 2. 24 小时未成交自动撤单
 * 3. 当日推荐出现反向方向时撤销未成交挂单，避免过期信号反向成交
 *
 * 只处理 orderType='limit' 且 status='pending' 的交易记录，市价单与加仓单不受影响。
 */
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {OverallRecModel} from "buydip_scheme";
import moment from "moment";
import {LIMIT_ORDER_TTL_MS} from "./limitEntryPrice";
import {getUserPositions} from "./apiTrade";
import {decrypt} from "./utils";
import {cancelGateOrder, getGateOpenOrders, placeGateProtection} from "./gateTrade";
import BinanceFuturesTrade from "./BinanceFutures/BinanceFuturesTrade";
import OKXFuturesTrader from "./OKXFutures/OKXFuturesTrade";
import BybitFuturesTrader from "./BybitFutures/BybitFuturesTrade";
import BitgetFuturesTrade from "./BitgetFutures/BitgetFuturesTrade";

const CHECK_INTERVAL = 60 * 1000;

const logger = {
    info: (...args) => console.log('[限价入场]', new Date().toISOString(), ...args),
    warn: (...args) => console.warn('[限价入场]', new Date().toISOString(), ...args),
    error: (...args) => console.error('[限价入场]', new Date().toISOString(), ...args)
};

/**
 * 统一币种格式：去掉各交易所的后缀，便于与交易记录里的 symbol 对齐
 */
const normalizeSymbol = (symbol) => String(symbol || '')
    .toUpperCase()
    .replace('-USDT-SWAP', '')
    .replace('USDT_UMCBL', '')
    .replace('_USDT', '')
    .replace(/USDT$/, '');

/**
 * 构建各交易所的限价单操作适配器
 * @param {Object} userOption - 用户交易配置
 * @returns {Object|null}
 */
const createAdapter = (userOption) => {
    const {apiKey, apiSecret, isTestOption, passphrase, belong} = userOption;

    switch (belong) {
        case 'Gate': {
            return {
                // Gate 不支持随限价单附带止盈止损，成交后补挂
                needsDeferredProtection: true,
                async getOpenOrders() {
                    const {futuresApi, settle, orders} = await getGateOpenOrders(userOption);
                    return {orders, ctx: {futuresApi, settle}};
                },
                async cancelOrder(ctx, record) {
                    await cancelGateOrder({futuresApi: ctx.futuresApi, settle: ctx.settle, orderId: record.orderId});
                },
                async placeProtection(record, position) {
                    return placeGateProtection({
                        userOptions: userOption,
                        symbol: record.symbol,
                        direction: record.direction,
                        entryPrice: position.entryPrice
                    });
                }
            };
        }
        case 'Binance': {
            const trader = new BinanceFuturesTrade(decrypt(apiKey), decrypt(apiSecret), isTestOption);
            return {
                needsDeferredProtection: true,
                async getOpenOrders() {
                    const orders = await trader.getOpenOrders();
                    return {orders: orders || [], ctx: {trader}};
                },
                async cancelOrder(ctx, record) {
                    await ctx.trader.cancelOrder(`${record.symbol}USDT`, record.orderId);
                },
                async placeProtection(record, position) {
                    await ctxSafePlaceBinance(trader, record, position, userOption);
                    return true;
                }
            };
        }
        case 'OKX': {
            const trader = new OKXFuturesTrader({
                apiKey: decrypt(apiKey),
                secretKey: decrypt(apiSecret),
                passphrase,
                isSimulated: isTestOption
            });
            return {
                needsDeferredProtection: false, // attachAlgoOrds 随限价单附带
                async getOpenOrders() {
                    const orders = await trader.client.getOpenOrders();
                    return {orders: orders || [], ctx: {trader}};
                },
                async cancelOrder(ctx, record) {
                    await ctx.trader.client.cancelOrder(`${record.symbol}-USDT-SWAP`, record.orderId);
                },
                async placeProtection() {
                    return true;
                }
            };
        }
        case 'Bybit': {
            const trader = new BybitFuturesTrader({
                apiKey: decrypt(apiKey),
                secretKey: decrypt(apiSecret),
                isTestnet: isTestOption
            });
            return {
                needsDeferredProtection: false, // takeProfit/stopLoss 随限价单附带
                async getOpenOrders() {
                    const orders = await trader.client.getOpenOrders();
                    return {orders: orders || [], ctx: {trader}};
                },
                async cancelOrder(ctx, record) {
                    await ctx.trader.client.cancelOrder(`${record.symbol}USDT`, record.orderId);
                },
                async placeProtection() {
                    return true;
                }
            };
        }
        case 'Bitget': {
            const trader = new BitgetFuturesTrade({
                apiKey: decrypt(apiKey),
                secretKey: decrypt(apiSecret),
                passphrase,
                isSimulated: isTestOption
            });
            return {
                needsDeferredProtection: false, // presetStop*Price 随限价单附带
                async getOpenOrders() {
                    const orders = await trader.client.getPendingOrders();
                    return {orders: orders || [], ctx: {trader}};
                },
                async cancelOrder(ctx, record) {
                    await ctx.trader.client.cancelOrder(record.symbol, record.orderId);
                },
                async placeProtection() {
                    return true;
                }
            };
        }
        default:
            return null;
    }
};

/**
 * Binance 补挂止盈止损（按持仓方向换算 LONG/SHORT）
 */
const ctxSafePlaceBinance = async (trader, record, position, userOption) => {
    await trader.placeEntryProtection({
        symbol: `${record.symbol}USDT`,
        direction: record.direction === 'buy' ? 'LONG' : 'SHORT',
        entryPrice: position.entryPrice,
        takeProfitPercent: Number(userOption.takeProfit) || 0,
        stopLossPercent: Number(userOption.stopLoss) || 0
    });
};

/**
 * 处理单个用户的限价入场单
 * @param {Object} userOption - 用户交易配置
 * @param {Object} recDirections - 今日推荐方向 {SYMBOL: Set<buy|sell>}
 */
const handleUserLimitOrders = async (userOption, recDirections) => {
    const exchange = String(userOption.belong || '').toLowerCase();

    // 只取最近 25 小时内的限价单（24 小时有效期 + 1 小时缓冲）
    const records = await TradeRecordModel.find({
        userId: userOption.userId,
        exchange,
        orderType: 'limit',
        status: 'pending',
        createdAt: {$gte: moment().subtract(LIMIT_ORDER_TTL_MS + 60 * 60 * 1000, 'milliseconds').toDate()}
    }).lean();

    if (records.length === 0) return {filled: 0, cancelled: 0};

    const adapter = createAdapter(userOption);
    if (!adapter) return {filled: 0, cancelled: 0};

    const {orders, ctx} = await adapter.getOpenOrders();
    const openOrderIds = new Set(orders.map(o => String(o.orderId || o.id || o.ordId || o.orderID || '')));

    const positions = await getUserPositions(userOption);
    const positionMap = {};
    for (const pos of positions) {
        positionMap[normalizeSymbol(pos.symbol)] = pos;
    }

    let filled = 0;
    let cancelled = 0;

    for (const record of records) {
        try {
            const symbolKey = normalizeSymbol(record.symbol);
            const currentPosition = positionMap[symbolKey];
            // 只认同方向持仓：反向持仓属于旧仓位（反手流程会先平掉），不能据此判断限价单成交
            const position = currentPosition && currentPosition.direction === record.direction ? currentPosition : null;
            const orderOpen = openOrderIds.has(String(record.orderId));
            const age = Date.now() - new Date(record.createdAt).getTime();

            // 1. 已产生持仓：登记成交并（按需）补挂止盈止损
            if (position && !record.entryFilled) {
                let ok = true;
                // 加仓单沿用原仓位的止盈止损，成交后不重挂（避免按加仓价把原止损整体挪走）
                if (adapter.needsDeferredProtection && !record.isAddPosition) {
                    ok = await adapter.placeProtection(record, position);
                }
                if (ok) {
                    await TradeRecordModel.updateOne({_id: record._id}, {
                        $set: {
                            entryFilled: true,
                            price: String(position.entryPrice || record.price),
                            size: String(position.size || record.size)
                        }
                    });
                    filled++;
                    logger.info(`${record.symbol}（${userOption.belong}）限价单已成交，入场价 ${position.entryPrice}`);
                } else {
                    logger.warn(`${record.symbol}（${userOption.belong}）已成交但补挂止盈止损失败，下轮重试`);
                }
            }

            // 2. 仍在交易所挂着：反向信号 or 超过24小时 -> 撤单
            if (orderOpen) {
                const directions = recDirections[symbolKey];
                const hasOpposite = directions && [...directions].some(d => d && d !== record.direction);
                // 已有持仓（部分成交）时不能把记录关闭，只撤销未成交的剩余挂单
                const statusAfterCancel = position ? 'pending' : 'cancelled';

                if (hasOpposite) {
                    await adapter.cancelOrder(ctx, record);
                    await TradeRecordModel.updateOne({_id: record._id}, {$set: {status: statusAfterCancel}});
                    cancelled++;
                    logger.info(`${record.symbol}（${userOption.belong}）出现反向推荐，已撤销限价挂单`);
                } else if (age >= LIMIT_ORDER_TTL_MS) {
                    await adapter.cancelOrder(ctx, record);
                    await TradeRecordModel.updateOne({_id: record._id}, {$set: {status: statusAfterCancel}});
                    cancelled++;
                    logger.info(`${record.symbol}（${userOption.belong}）限价单挂满24小时未成交，已撤单`);
                }
                continue;
            }

            // 3. 已不在交易所挂单且无持仓：未成交被撤 / 已成交后平仓，关闭记录
            if (!position) {
                await TradeRecordModel.updateOne({_id: record._id}, {$set: {status: 'cancelled'}});
                cancelled++;
            }
        } catch (e) {
            logger.error(`${record.symbol}（${userOption.belong}）限价单处理失败:`, e.message);
        }
    }

    return {filled, cancelled};
};

/**
 * 执行一轮限价入场单检查（定时任务入口）
 */
let isRunning = false;

export const handleLimitEntryOrders = async () => {
    // 上一轮未结束时跳过，避免重复撤单/重复补挂
    if (isRunning) return {success: true, message: '上一轮仍在执行'};
    isRunning = true;
    try {
        const activeUsers = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false
        }).lean();

        if (activeUsers.length === 0) return {success: true, message: '无活跃用户'};

        // 今日推荐方向（用于识别反向信号）
        const todayRecs = await OverallRecModel.find({
            createdAt: {$gte: moment().startOf('day').toDate()}
        }).lean();

        const recDirections = {};
        for (const rec of todayRecs) {
            const key = normalizeSymbol(rec.symbol);
            if (!recDirections[key]) recDirections[key] = new Set();
            recDirections[key].add(rec.direction);
        }

        let totalFilled = 0;
        let totalCancelled = 0;
        for (const userOption of activeUsers) {
            try {
                const result = await handleUserLimitOrders(userOption, recDirections);
                totalFilled += result.filled || 0;
                totalCancelled += result.cancelled || 0;
            } catch (e) {
                logger.error(`用户 ${userOption.userId}（${userOption.belong}）限价单检查失败:`, e.message);
            }
        }

        if (totalFilled > 0 || totalCancelled > 0) {
            logger.info(`本轮完成：成交 ${totalFilled} 单，撤单 ${totalCancelled} 单`);
        }
        return {success: true, totalFilled, totalCancelled};
    } catch (error) {
        logger.error('限价入场单检查失败:', error.message);
        return {success: false, message: error.message};
    } finally {
        isRunning = false;
    }
};

/**
 * 启动限价入场单管理器
 */
export const startLimitEntryManager = () => {
    logger.info(`启动限价入场单管理器，间隔: ${CHECK_INTERVAL / 1000} 秒`);

    // 启动后延迟 30 秒执行一次，避免与其它启动任务争抢交易所接口
    setTimeout(handleLimitEntryOrders, 30 * 1000);
    setInterval(handleLimitEntryOrders, CHECK_INTERVAL);
};

/**
 * 手动触发（便于排查）
 */
export const triggerLimitEntryManager = async (req, res) => {
    try {
        const result = await handleLimitEntryOrders();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({success: false, message: error.message});
    }
};
