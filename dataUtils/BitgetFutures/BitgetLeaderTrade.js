const BitgetFuturesClient = require('./BitgetFuturesClient');

/**
 * Bitget带单交易类
 * 用于执行带单交易相关的操作
 */
class BitgetLeaderTrade {
    /**
     * 构造函数
     * @param {Object} config - 配置对象
     * @param {string} config.apiKey - API密钥
     * @param {string} config.secretKey - 密钥
     * @param {string} config.passphrase - 密码短语
     * @param {boolean} config.isSimulated - 是否模拟交易
     */
    constructor({apiKey, secretKey, passphrase, isSimulated = false}) {
        this.client = new BitgetFuturesClient({apiKey, secretKey, passphrase, isSimulated});
    }

    /**
     * 获取最新价格
     * @param {Object} ticker - 行情数据
     * @returns {number} 最新价格
     */
    _getTickerLastPrice(ticker) {
        if (!ticker) return 0;
        const candidates = [
            ticker.last,
            ticker.lastPrice,
            ticker.last_price,
            ticker.markPrice,
            ticker.indexPrice,
            ticker.price
        ];
        for (const c of candidates) {
            const n = parseFloat(c);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return 0;
    }

    /**
     * 执行带单交易
     * @param {Object} params - 参数对象
     * @param {string} params.symbol - 交易对符号
     * @param {number} params.usdtAmount - USDT金额
     * @param {string} params.direction - 交易方向(buy/sell)
     * @param {number} params.leverage - 杠杆倍数
     * @param {number} params.takeProfitPercent - 止盈百分比
     * @param {number} params.stopLossPercent - 止损百分比
     * @param {string} params.settingDirection - 设置的方向过滤
     * @returns {Promise<Object>} 交易结果
     */
    async executeTrade(params) {
        const {
            symbol,
            usdtAmount,
            direction,
            leverage = 2,
            takeProfitPercent = 0,
            stopLossPercent = 0,
            settingDirection
        } = params;
        try {
            // 步骤1: 检查方向过滤
            if (!(settingDirection === 'all' || settingDirection === direction)) {
                return {success: false, message: '方向过滤未通过'};
            }

            // 步骤2: 获取当前价格
            const ticker = await this.client.getTicker(symbol);
            const currentPrice = this._getTickerLastPrice(ticker);
            if (currentPrice <= 0) {
                throw new Error('无法获取当前价格');
            }

            // 步骤3: 计算下单数量 (使用通用精度6位小数)
            const baseQty = (usdtAmount * leverage) / currentPrice;
            const size = Math.floor(baseQty * 1000000) / 1000000;
            if (size <= 0) {
                throw new Error('计算出的下单数量小于等于0');
            }

            // 步骤4: 计算止盈止损价格 (使用通用精度2位小数)
            let takeProfitPrice = undefined;
            let stopLossPrice = undefined;

            if (takeProfitPercent > 0) {
                takeProfitPrice = direction === 'buy'
                    ? currentPrice * (1 + takeProfitPercent / 100)
                    : currentPrice * (1 - takeProfitPercent / 100);
                takeProfitPrice = takeProfitPrice.toFixed(2);
            }
            if (stopLossPercent > 0) {
                stopLossPrice = direction === 'buy'
                    ? currentPrice * (1 - stopLossPercent / 100)
                    : currentPrice * (1 + stopLossPercent / 100);
                stopLossPrice = stopLossPrice.toFixed(2);
            }

            // 步骤5: 使用Bitget v3 API下单
            // 带单交易使用普通下单接口
            // v3 API参数说明:
            // - category: 产品类型 (USDT-FUTURES)
            // - symbol: 交易对符号 (如: BTCUSDT)
            // - marginCoin: 保证金币种 (USDT)
            // - qty: 下单数量
            // - side: 下单方向 (buy: 买, sell: 卖)
            // - orderType: 订单类型 (market: 市价单)
            // - posSide: 仓位方向 (long: 多头, short: 空头)
            // - leverage: 杠杆倍数
            // - takeProfit: 预设止盈触发价格
            // - stopLoss: 预设止损触发价格
            // - tpOrderType: 止盈触发的策略单类型 (limit: 限价单)
            // - tpLimitPrice: 止盈策略单执行价格
            // - slOrderType: 止损触发的策略单类型 (limit: 限价单)
            // - slLimitPrice: 止损策略单执行价格
            const order = await this.client.placeLeaderOrder({
                symbol: this.client._toV2Symbol(symbol),
                marginCoin: 'USDT',
                side: direction === 'buy' ? 'open_long' : 'open_short',
                orderType: 'market',
                size: `${size}`,
                leverage: `${leverage}`,
                tpTriggerPrice: takeProfitPrice,
                slTriggerPrice: stopLossPrice,
                tpOrderPrice: takeProfitPrice,
                slOrderPrice: stopLossPrice
            });

            return {
                success: true,
                order: order.data || order
            };
        } catch (error) {
            console.error('Bitget 带单交易执行失败:', error.message);
            return {success: false, error: error.message};
        }
    }
}

module.exports = BitgetLeaderTrade;