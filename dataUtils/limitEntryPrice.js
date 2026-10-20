/**
 * 限价入场价格计算
 *
 * 背景：市价入场在震荡行情里经常成交在局部高点/低点，改为限价挂单等待价格回到区间中值。
 *
 * 限价公式：最近 4 根日K的（最高价 + 最低价）/ 2
 * - 取最近 4 根 1d K线（含当日进行中的K线，其高低价随行情实时更新）
 * - 数据不足 4 根时用现有根数；完全没有K线则返回 null（调用方跳过该币种，不退回市价）
 */
import {KLineModel} from "buydip_scheme";

// 限价挂单有效期：24 小时未成交自动撤单
export const LIMIT_ORDER_TTL_MS = 24 * 60 * 60 * 1000;

// 限价参考的日K根数
export const LIMIT_LOOKBACK_DAYS = 4;

/**
 * 计算币种限价入场价格
 * @param {string} symbol - 币种，如 BTC
 * @returns {Promise<number|null>} 限价价格，无法计算时返回 null
 */
export const getLimitEntryPrice = async (symbol) => {
    try {
        if (!symbol) return null;

        const rows = await KLineModel.find({
            s: `${symbol.toUpperCase()}USDT`,
            i: '1d'
        }).sort({t: -1}).limit(LIMIT_LOOKBACK_DAYS).lean();

        if (!rows || rows.length === 0) return null;

        const highs = rows.map(r => Number(r.h)).filter(n => Number.isFinite(n) && n > 0);
        const lows = rows.map(r => Number(r.l)).filter(n => Number.isFinite(n) && n > 0);
        if (highs.length === 0 || lows.length === 0) return null;

        const price = (Math.max(...highs) + Math.min(...lows)) / 2;
        return Number.isFinite(price) && price > 0 ? price : null;
    } catch (error) {
        console.error(`[限价入场] ${symbol} 计算限价失败:`, error.message);
        return null;
    }
};
