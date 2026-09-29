/**
 * 统一加仓决策规则
 *
 * 规则：
 * 1. 入场当日不加仓，同个币种每日只入场(加仓)1次
 * 2. 每个币种最多加仓 maxAddPositionCount 次（后台「保本与加仓配置」页可配，默认3）
 * 3. 加仓资金/原始单资金比例（%）——亏损单、盈利单各一组，后台可配，默认 20/30/50 与 50/30/20
 *    比例按第 1/2/3… 次加仓依次取值，次数超出末位时按末位取值
 *
 * 加仓次数依据 TradeRecord：
 * - 该用户该币种 status='pending' 的记录数 - 1 = 已加仓次数（第一条为原始入场单）
 * - 平仓后记录状态会变更为 closed/cancelled，重新入场后计数重新开始
 */
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { BreakEvenConfigModel } from "buydip_scheme/scheme/breakEvenConfig";
import moment from "moment";

// 后台未配置/读取失败时的兜底值
const DEFAULT_MAX_ADD_POSITION_COUNT = 3;
const DEFAULT_LOSS_RATIOS = [20, 30, 50]; // 亏损单：20% / 30% / 50%
const DEFAULT_PROFIT_RATIOS = [50, 30, 20]; // 盈利单：50% / 30% / 20%

const toRatios = (list, fallback) => {
    const ratios = Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : [];
    return ratios.length ? ratios : fallback;
};

/**
 * 读取后台「保本与加仓配置」中的加仓参数
 * @returns {Promise<{maxAddPositionCount: number, lossRatios: number[], profitRatios: number[]}>}
 */
const loadAddPositionConfig = async () => {
    try {
        const config = await BreakEvenConfigModel.findOne().sort({createdAt: -1}).lean();
        const maxAddPositionCount = config?.maxAddPositionCount !== undefined && config?.maxAddPositionCount !== null
            ? Number(config.maxAddPositionCount)
            : DEFAULT_MAX_ADD_POSITION_COUNT;
        return {
            maxAddPositionCount,
            lossRatios: toRatios(config?.lossAddRatios, DEFAULT_LOSS_RATIOS),
            profitRatios: toRatios(config?.profitAddRatios, DEFAULT_PROFIT_RATIOS)
        };
    } catch (error) {
        console.error('[加仓规则] 读取加仓配置失败，使用默认值:', error.message);
        return {
            maxAddPositionCount: DEFAULT_MAX_ADD_POSITION_COUNT,
            lossRatios: DEFAULT_LOSS_RATIOS,
            profitRatios: DEFAULT_PROFIT_RATIOS
        };
    }
};

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

        // 读取后台配置（最大加仓次数 + 亏损单/盈利单两组比例）
        const { maxAddPositionCount, lossRatios, profitRatios } = await loadAddPositionConfig();

        // 规则2：每个币种最多加仓 maxAddPositionCount 次
        const pendingCount = await TradeRecordModel.countDocuments({ userId, symbol, status: 'pending' });
        const addCount = Math.max(0, pendingCount - 1);
        if (addCount >= maxAddPositionCount) {
            console.log(`[加仓规则] ${symbol} 已加仓 ${addCount} 次，达到上限 ${maxAddPositionCount} 次，不再加仓`);
            return null;
        }

        // 规则3：按当前持仓盈亏状态决定本次加仓资金比例
        const isProfit = Number(upl) > 0;
        const ratios = isProfit ? profitRatios : lossRatios;
        const ratioPct = ratios[Math.min(addCount, ratios.length - 1)];
        const addUsdt = Number((Number(maxVolume) * ratioPct / 100).toFixed(2));
        console.log(`[加仓规则] ${symbol} 第 ${addCount + 1} 次加仓（${isProfit ? '盈利单' : '亏损单'}）：原始单 ${maxVolume} × ${ratioPct}% = ${addUsdt} USDT`);
        return { addUsdt, addCount, isProfit };
    } catch (error) {
        console.error(`[加仓规则] ${symbol} 决策异常，放弃加仓:`, error.message);
        return null;
    }
};
