/**
 * 限价入场价格计算
 *
 * 背景：市价入场在震荡行情里经常成交在局部高点/低点，改为限价挂单等待价格回到区间中值。
 *
 * 限价公式（须与 engine/dataUtils/getLimitEntryPrice.js 保持一致）：
 * - X/J/L 策略（marketSignal / priceTrend / continuousFundFlow）：
 *     买入 = 最近 4 根日K最低价 × 买入系数（默认 1.02）
 *     卖出 = 最近 4 根日K最高价 × 卖出系数（默认 0.98）
 * - 其余限价策略（cci）：最近 4 根日K的（最高价 + 最低价）/ 2
 * 系数由后台「设置管理」配置（frontendSettings.limitBuyRatio / limitSellRatio）。
 * - 取最近 4 根 1d K线（含当日进行中的K线，其高低价随行情实时更新）
 * - 数据不足 4 根时用现有根数；完全没有K线则返回 null（调用方跳过该币种，不退回市价）
 */
import {KLineModel, PageDataModel} from "buydip_scheme";

// 限价挂单有效期：24 小时未成交自动撤单
export const LIMIT_ORDER_TTL_MS = 24 * 60 * 60 * 1000;

// 限价参考的日K根数
export const LIMIT_LOOKBACK_DAYS = 4;

// 按方向取边界价的策略（X 币种信号 / J 价格趋势 / L 连续资金流）
export const LIMIT_EDGE_STRATEGIES = ['marketSignal', 'priceTrend', 'continuousFundFlow'];

// 系数默认值（后台未配置时使用）
export const DEFAULT_LIMIT_RATIOS = {
    limitBuyRatio: 1.02,
    limitSellRatio: 0.98
};

/**
 * 读取后台配置的买卖限价系数
 * @returns {Promise<{limitBuyRatio: number, limitSellRatio: number}>}
 */
export const getLimitPriceRatios = async () => {
    try {
        const doc = await PageDataModel.findOne({name: 'frontendSettings'}).lean();
        const data = doc?.data || {};
        const buy = Number(data.limitBuyRatio);
        const sell = Number(data.limitSellRatio);
        return {
            limitBuyRatio: Number.isFinite(buy) && buy > 0 ? buy : DEFAULT_LIMIT_RATIOS.limitBuyRatio,
            limitSellRatio: Number.isFinite(sell) && sell > 0 ? sell : DEFAULT_LIMIT_RATIOS.limitSellRatio
        };
    } catch (error) {
        console.error('[限价入场] 读取限价系数失败，使用默认值:', error.message);
        return {...DEFAULT_LIMIT_RATIOS};
    }
};

/**
 * 计算币种限价入场价格
 * @param {string} symbol - 币种，如 BTC
 * @param {Object} [options]
 * @param {string} [options.direction] - buy / sell
 * @param {string} [options.strategy] - 策略名（决定是否按方向取边界价）
 * @returns {Promise<number|null>} 限价价格，无法计算时返回 null
 */
export const getLimitEntryPrice = async (symbol, {direction, strategy} = {}) => {
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

        const highest = Math.max(...highs);
        const lowest = Math.min(...lows);

        // 区间中值：cci 等未按方向取边界的策略沿用原公式
        if (!LIMIT_EDGE_STRATEGIES.includes(strategy) || (direction !== 'buy' && direction !== 'sell')) {
            const midPrice = (highest + lowest) / 2;
            return Number.isFinite(midPrice) && midPrice > 0 ? midPrice : null;
        }

        const ratios = await getLimitPriceRatios();
        const price = direction === 'buy'
            ? lowest * ratios.limitBuyRatio
            : highest * ratios.limitSellRatio;
        return Number.isFinite(price) && price > 0 ? price : null;
    } catch (error) {
        console.error(`[限价入场] ${symbol} 计算限价失败:`, error.message);
        return null;
    }
};
