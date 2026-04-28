const BitgetFuturesClient = require('./BitgetFuturesClient');
const {formatPrice} = require("../formatPrice");

class BitgetFuturesTrade {
    constructor({apiKey, secretKey, passphrase, isSimulated = false}) {
        this.client = new BitgetFuturesClient({apiKey, secretKey, passphrase, isSimulated});
    }

    async _retry(fn, retries = 3, delayMs = 800) {
        let lastErr;
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (e) {
                lastErr = e;
                await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
            }
        }
        throw lastErr;
    }

    async getSymbolsInfo() {
        return this._retry(() => this.client.getContracts(), 3, 1000);
    }

    async getAccountInfo() {
        console.log("获取账户")
        try {
            const account = await this._retry(() => this.client.getAccount(), 3, 1000);
            if (!account) {
                throw new Error('未获取到账户信息');
            }
            const balance = {
                total: account?.equity ?? account?.accountEquity ?? account?.totalEquity ?? account?.available ?? '0',
                unrealisedPnl: account?.unrealizedPL ?? account?.unrealisedPnl ?? account?.upl ?? '0',
                available: account?.available ?? account?.availableBalance ?? account?.availBal ?? '0'
            };
            console.log("获取账户信息成功:", balance);
            return { balance };
        } catch (error) {
            console.error('获取账户信息失败:', error.message);
            // 抛出错误，让调用方知道发生了问题
            throw error;
        }
    }

    async checkMargin(usdtAmount, minMargin = 0) {
        const accountInfo = await this.getAccountInfo();
        const available = parseFloat(accountInfo.balance.available || 0);
        if (available < minMargin) {
            throw new Error(`保证金不足，可用余额 ${available} USDT 小于最小要求 ${minMargin} USDT`);
        }
        if ((available - minMargin) < usdtAmount) {
            throw new Error(`保证金不足，需要 ${usdtAmount} USDT，但只有 ${available} USDT 可用`);
        }
        return true;
    }

    _toNumber(v, d = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    }

    _roundFloor(value, decimals = 0) {
        const factor = Math.pow(10, decimals);
        return Math.floor(value * factor) / factor;
    }

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

    calculateQuantity({symbolInfo, currentPrice, usdtAmount, leverage = 1}) {
        const markPrice = this._toNumber(currentPrice, 0);
        if (markPrice <= 0) {
            throw new Error('当前价格无效，无法计算下单数量');
        }

        // 计算基础币数量（不除以 sizeMultiplier）
        const baseQty = (usdtAmount * leverage) / markPrice;

        if (!symbolInfo) {
            // 当无法获取 contracts 详情时，使用通用精度做保守下取整
            const qty = this._roundFloor(baseQty, 6);
            if (qty <= 0) throw new Error('计算出的下单数量小于等于0');
            return `${qty}`;
        }

        // 从 symbolInfo 获取精度信息
        const volumePlace = this._toNumber(symbolInfo.volumePlace, 0);
        const minTradeNum = this._toNumber(symbolInfo.minTradeNum, 0);

        // 使用 volumePlace 对基础数量进行精度调整
        let quantity = this._roundFloor(baseQty, volumePlace);

        // 确保数量满足最小交易量要求
        if (quantity < minTradeNum) {
            quantity = minTradeNum;
        }

        if (quantity <= 0) throw new Error('计算出的下单数量小于等于0');
        return `${quantity}`;
    }

    async getCurrentPosition(symbol) {
        const positions = await this.client.getPositions();
        const pos = positions.find((item) => item.symbol === `${symbol}USDT` && Math.abs(this._toNumber(item.total, 0)) > 0);
        if (!pos) return null;
        return {
            symbol: pos.symbol,
            holdSide: pos.holdSide,
            total: this._toNumber(pos.total, 0),
            upl: this._toNumber(pos.unrealizedPL, 0)
        };
    }

    async setTakeProfitAndStopLoss({symbol, side, entryPrice, takeProfitPercent, stopLossPercent}) {
        if (takeProfitPercent <= 0 && stopLossPercent <= 0) return;

        const isLong = side === 'open_long';
        const plans = [];

        if (stopLossPercent > 0) {
            const stopLossPrice = isLong
                ? entryPrice * (1 - stopLossPercent / 100)
                : entryPrice * (1 + stopLossPercent / 100);
            plans.push(this.client.placeTPSLPlan({
                symbol: this.client.formatSymbol(symbol),
                marginCoin: 'USDT',
                planType: 'loss_plan',
                triggerPrice: `${stopLossPrice}`,
                triggerType: 'fill_price',
                holdSide: isLong ? 'long' : 'short'
            }));
        }

        if (takeProfitPercent > 0) {
            const takeProfitPrice = isLong
                ? entryPrice * (1 + takeProfitPercent / 100)
                : entryPrice * (1 - takeProfitPercent / 100);
            plans.push(this.client.placeTPSLPlan({
                symbol: this.client.formatSymbol(symbol),
                marginCoin: 'USDT',
                planType: 'profit_plan',
                triggerPrice: `${takeProfitPrice}`,
                triggerType: 'fill_price',
                holdSide: isLong ? 'long' : 'short'
            }));
        }

        for (const task of plans) {
            try {
                await task;
            } catch (e) {
                console.log('设置止盈止损失败(忽略):', e.message);
            }
        }
    }

    async executeTrade(params) {
        const {
            symbol,
            usdtAmount,
            direction,
            leverage = 2,
            minMargin = 0,
            takeProfitPercent = 0,
            stopLossPercent = 0,
            symbolInfo,
            settingDirection
        } = params;
        try {
            console.log("11111111111")
            try {
                await this.client.setPositionMode();
                await new Promise((r) => setTimeout(r, 100));
            } catch (modeError) {
                console.warn('切换持仓模式失败，继续使用当前模式:', modeError.message);
                // 不抛出错误，继续执行交易
            }
            console.log("2222222222")

            await this.checkMargin(usdtAmount, minMargin);
            console.log("3333333333")

            await new Promise((r) => setTimeout(r, 100));
            await this.client.setLeverage(symbol, leverage);
            console.log("44444444444")

            await new Promise((r) => setTimeout(r, 100));

            const ticker = await this.client.getTicker(symbol);
            console.log("55555555")
            console.log("ticker", ticker)
            const currentPrice = this._getTickerLastPrice(ticker);
            console.log("666666666666")
            console.log(symbolInfo,
                currentPrice,
                usdtAmount,
                leverage)
            const size = this.calculateQuantity({
                symbolInfo,
                currentPrice,
                usdtAmount,
                leverage
            });
            console.log("7777777777777", size)
            const currentPosition = await this.getCurrentPosition(symbol);
            console.log("currentPosition", currentPosition)
            console.log("88888888888888")

            if (currentPosition) {
                const isOpposite = (currentPosition.holdSide === 'long' && direction === 'sell')
                    || (currentPosition.holdSide === 'short' && direction === 'buy');
                if (isOpposite) {
                    await this.client.closePosition(symbol, currentPosition.holdSide, currentPosition.total);
                    await new Promise((r) => setTimeout(r, 150));
                } else {
                    const isSameDirection = (currentPosition.holdSide === 'long' && direction === 'buy')
                        || (currentPosition.holdSide === 'short' && direction === 'sell');
                    if (isSameDirection && currentPosition.upl <= 0) {
                        return {success: false, message: '同向持仓未盈利，不加仓'};
                    }
                }
            }

            if (!(settingDirection === 'all' || settingDirection === direction)) {
                return {success: false, message: '方向过滤未通过'};
            }

            const side = direction === 'buy' ? 'buy' : 'sell';
            let takeProfitPrice = undefined;
            let stopLossPrice = undefined;
            const priceStep = symbolInfo?.pricePlace
            console.log("priceStep",priceStep)
            if (takeProfitPercent > 0) {
                takeProfitPrice = direction === 'buy'
                    ? currentPrice * (1 + takeProfitPercent / 100)
                    : currentPrice * (1 - takeProfitPercent / 100);
                takeProfitPrice = takeProfitPrice.toFixed(Number(priceStep))
            }
            if (stopLossPercent > 0) {
                stopLossPrice = direction === 'buy'
                    ? currentPrice * (1 - stopLossPercent / 100)
                    : currentPrice * (1 + stopLossPercent / 100);
                stopLossPrice = stopLossPrice.toFixed(Number(priceStep));
            }
            // Bitget v2 下单时用 preset*Price 一次性挂好止盈止损
            const order = await this.client.placeOrder({
                symbol,
                size,
                side,
                tradeSide: 'open',
                orderType: 'market',
                force: 'ioc',
                presetStopSurplusPrice: takeProfitPrice,
                presetStopLossPrice: stopLossPrice
            });

            return {
                success: true,
                order: order.data || {}
            };
        } catch (error) {
            console.error('Bitget 交易执行失败:', error.message);
            return {success: false, error: error.message};
        }
    }

    async getPositions() {
        return this.client.getPositions();
    }

    /**
     * 使用Bitget专用平仓接口批量平仓
     * @param {Object} params - 平仓参数
     * @param {string} [params.symbol] - 交易对
     * @param {string} [params.holdSide] - 持仓方向 (long/short)
     * @param {string} params.productType - 产品类型 (USDT-FUTURES/COIN-FUTURES/USDC-FUTURES)
     * @returns {Promise<Object>} 平仓结果
     */
    async closePositionsAPI(params) {
        return this.client.closePositionsAPI(params);
    }
}

module.exports = BitgetFuturesTrade;
