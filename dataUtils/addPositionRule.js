/**
 * 统一加仓决策规则
 *
 * 规则：
 * 1. 入场当日不加仓，同个币种每日只入场(加仓)1次
 * 2. 每个币种最多加仓3次
 * 3. 3次加仓资金/原始单资金比例 —— 亏损单: 20%/30%/50%，盈利单: 50%/30%/20%
 *
 * 加仓次数依据 TradeRecord：
 * - 该用户该币种 status='pending' 的记录数 - 1 = 已加仓次数（第一条为原始入场单）
 * - 平仓后记录状态会变更为 closed/cancelled，重新入场后计数重新开始
 */
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import moment from "moment";

// 每个币种最多加仓次数
const MAX_ADD_POSITION_COUNT = 3;
// 加仓资金/原始单资金比例（索引 0/1/2 对应第 1/2/3 次加仓）
const LOSS_RATIOS = [0.2, 0.3, 0.5]; // 亏损单：20% / 30% / 50%
const PROFIT_RATIOS = [0.5, 0.3, 0.2]; // 盈利单：50% / 30% / 20%

/**
 * 获取同向持仓时的加仓决策
 * @param {Object} params
 * @param {String|ObjectId} params.userId 用户ID（与 saveTradeRecord 写入一致，users 表 ObjectId）
 * @param {String} params.symbol 币种（如 BTC）
 * @param {Number} params.maxVolume 原始单资金（USDT）
 * @param {Number} params.upl 当前持仓未实现盈亏（>0 视为盈利单）
 * @returns {Promise<Object|null>} null=不加仓（今日已交易过/已达上限/异常）；否则 { addUsdt, addCount, isProfit }
 */
export const getAddPositionDecision = async ({ userId, symbol, maxVolume, upl }) => {
    try {
        // 规则1：入场当日不加仓，同个币种每日只入场(加仓)1次
        const todayCount = await TradeRecordModel.countDocuments({
            userId,
            symbol,
            createdAt: { $gte: moment().startOf('day').toDate() }
        });
        if (todayCount > 0) {
            console.log(`[加仓规则] ${symbol} 今日已入场/加仓过，当日不再操作`);
            return null;
        }

        // 规则2：每个币种最多加仓3次
        const pendingCount = await TradeRecordModel.countDocuments({ userId, symbol, status: 'pending' });
        const addCount = Math.max(0, pendingCount - 1);
        if (addCount >= MAX_ADD_POSITION_COUNT) {
            console.log(`[加仓规则] ${symbol} 已加仓 ${addCount} 次，达到上限 ${MAX_ADD_POSITION_COUNT} 次，不再加仓`);
            return null;
        }

        // 规则3：按当前持仓盈亏状态决定本次加仓资金比例
        const isProfit = Number(upl) > 0;
        const ratio = (isProfit ? PROFIT_RATIOS : LOSS_RATIOS)[addCount];
        const addUsdt = Number((Number(maxVolume) * ratio).toFixed(2));
        console.log(`[加仓规则] ${symbol} 第 ${addCount + 1} 次加仓（${isProfit ? '盈利单' : '亏损单'}）：原始单 ${maxVolume} × ${ratio * 100}% = ${addUsdt} USDT`);
        return { addUsdt, addCount, isProfit };
    } catch (error) {
        console.error(`[加仓规则] ${symbol} 决策异常，放弃加仓:`, error.message);
        return null;
    }
};
