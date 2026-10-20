// binance-futures-trader.js
const BinanceFuturesClient = require('./BinanceFuturesClient');
const {formatPrice} = require("../formatPrice");
// 网络请求重试函数
const retryRequest = async (fn, retries = 3, delay = 2000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`请求失败，第${i + 1}次尝试:`, error.message);
            if (i === retries - 1) {
                // 最后一次尝试失败，抛出错误
                throw error;
            }
            // 等待一段时间再重试
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};


class BinanceFuturesTrader {
    constructor(apiKey, apiSecret, isTestnet = false) {
        this.client = new BinanceFuturesClient(apiKey, apiSecret, isTestnet);
    }

    async checkUserAccount() {
        try {
            return await retryRequest(() => this.client.getAccountInfo());
        } catch (e) {
            console.error('获取Binance余额失败:', e.message);
            throw e;
        }
    }

    /**
     * 检查保证金是否充足
     */
    async checkMargin(symbol, usdtAmount, minMargin) {
        try {
            const accountInfo = await retryRequest(() => this.client.getAccountInfo());
            const availableBalance = parseFloat(accountInfo.availableBalance);

            // 检查最小保证金要求
            if (availableBalance < minMargin) {
                throw new Error(`保证金不足，可用余额 ${availableBalance} USDT 小于最小要求 ${minMargin} USDT`);
            }

            // 计算所需保证金
            const currentPrice = await retryRequest(() => this.client.getCurrentPrice(symbol));
            const quantity = usdtAmount / currentPrice;
            const requiredMargin = usdtAmount; // 简化计算，实际应考虑杠杆

            if (availableBalance < requiredMargin) {
                throw new Error(`保证金不足，需要 ${requiredMargin} USDT，但只有 ${availableBalance} USDT`);
            }

            return true;
        } catch (error) {
            console.error('检查保证金失败:', error.message);
            throw error;
        }
    }

    /**
     * 计算交易数量
     */
    async calculateQuantity(symbolInfo, usdtAmount, currentPrice, leverage = 1) {
        try {
            // 获取数量精度
            const quantityFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
            const stepSize = parseFloat(quantityFilter.stepSize);

            // 与 Gate/OKX/Bybit/Bitget 口径统一：usdtAmount 为名义资金，实际下单量 = 资金 × 杠杆 / 价格
            let quantity = (usdtAmount * leverage) / currentPrice;
            quantity = Math.floor(quantity / stepSize) * stepSize;
            quantity = quantity.toFixed(symbolInfo.quantityPrecision);
            return quantity
        } catch (error) {
            console.error('计算数量失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取当前持仓
     */
    async getCurrentPosition(symbol) {
        try {
            const accountInfo = await retryRequest(() => this.client.getAccountInfo());
            const position = accountInfo.positions.find(p => p.symbol === symbol);

            if (position && parseFloat(position.positionAmt) !== 0) {
                return {
                    symbol: position.symbol,
                    positionAmt: parseFloat(position.positionAmt),
                    positionSide: parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT',
                    entryPrice: parseFloat(position.entryPrice),
                    leverage: parseFloat(position.leverage)
                };
            }

            return null;
        } catch (error) {
            console.error('获取持仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取所有持仓
     */
    async getPositions() {
        try {
            const accountInfo = await retryRequest(() => this.client.getAccountInfo());
            return accountInfo.positions || [];
        } catch (error) {
            console.error('获取所有持仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 平仓
     */
    async closePosition(symbol) {
        try {
            const position = await retryRequest(() => this.getCurrentPosition(symbol));

            if (!position) {
                console.log('没有持仓需要平仓');
                return null;
            }

            const side = position.positionSide === 'LONG' ? 'SELL' : 'BUY';
            const quantity = Math.abs(position.positionAmt);

            console.log(`平仓: ${side} ${quantity} ${symbol}`);

            return await retryRequest(() => this.client.placeMarketOrder(
                symbol,
                side,
                quantity,
                true // reduceOnly
            ));
        } catch (error) {
            console.error('平仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 设置止盈止损
     */
    async setTakeProfitAndStopLoss(symbolInfo, entryPrice, quantity, takeProfitPercent, stopLossPercent, direction) {
        try {
            const symbol = symbolInfo.symbol;
            const priceStep = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize;
            const results = {};

            // 重挂前先撤销该合约已有的条件单：币安对"同方向已有 closePosition 全仓条件单"
            // 会直接拒单（An open stop or take profit order with closePosition ... is existing）
            try {
                await this.cancelAllAlgoOrders(symbol);
                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (e) {
                console.log('撤销旧条件单失败(忽略):', e.message);
            }

            // 计算止盈止损价格
            let takeProfitPrice, stopLossPrice;

            if (direction === 'LONG') {
                if (takeProfitPercent) {
                    takeProfitPrice = entryPrice * (1 + takeProfitPercent / 100);
                    takeProfitPrice = formatPrice(takeProfitPrice, Number(priceStep));
                }
                if (stopLossPercent) {
                    stopLossPrice = entryPrice * (1 - stopLossPercent / 100);
                    stopLossPrice = formatPrice(stopLossPrice, Number(priceStep));
                }
            } else {
                if (takeProfitPercent) {
                    takeProfitPrice = entryPrice * (1 - takeProfitPercent / 100);
                    takeProfitPrice = formatPrice(takeProfitPrice, Number(priceStep));
                }
                if (stopLossPercent) {
                    stopLossPrice = entryPrice * (1 + stopLossPercent / 100);
                    stopLossPrice = formatPrice(stopLossPrice, Number(priceStep));
                }
            }

            console.log("takeProfitPrice", takeProfitPrice, "stopLossPrice", stopLossPrice)
            const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
            // 设置止盈单 - 使用正确的订单类型
            if (takeProfitPercent > 0 && Number(takeProfitPrice) > 0) {
                results.takeProfit = await retryRequest(() => this.client.placeAlgoOrder(symbol, {
                    side: closeSide,
                    type: 'TAKE_PROFIT_MARKET', // 使用市价止盈
                    quantity: quantity,
                    triggerPrice: Number(takeProfitPrice),
                    closePosition: 'true', // 平仓
                }));
                console.log(`止盈单设置: ${takeProfitPrice}`);
            }

            // 设置止损单 - 使用正确的订单类型
            if (stopLossPercent > 0 && Number(stopLossPrice) > 0) {
                results.stopLoss = await retryRequest(() => this.client.placeAlgoOrder(symbol, {
                    side: closeSide,
                    type: 'STOP_MARKET', // 使用市价止损
                    quantity: quantity,
                    triggerPrice: Number(stopLossPrice),
                    closePosition: 'true', // 平仓
                }));
                console.log(`止损单设置: ${stopLossPrice}`);
            }
            return results;
        } catch (error) {
            console.error('设置止盈止损失败:', error.message);
            throw error;
        }
    }

    async setupDualPositionMode() {
        try {
            // 获取当前持仓模式
            const currentMode = await retryRequest(() => this.client.getPositionMode());
            console.log('当前持仓模式:', currentMode);
            if (currentMode.dualSidePosition) {
                // 设置为单向持仓模式
                const result = await retryRequest(() => this.client.setPositionMode(false));
                console.log('设置单向持仓模式成功:', result);
                // 验证设置
                const newMode = await retryRequest(() => this.client.getPositionMode());
                console.log('新的持仓模式:', newMode);
            }
        } catch (error) {
            console.error('设置持仓模式失败:', error);
        }
    }

    /**
     * 执行交易
     */
    async executeTrade(params) {
        const {
            symbol,
            usdtAmount,
            direction, // 'LONG' or 'SHORT'
            leverage,
            minMargin,
            takeProfitPercent,
            stopLossPercent,
            symbolInfo,
            settingDirection,
            limitPrice,
            entryType = 'market'
        } = params;
        try {
            const isLimitEntry = entryType === 'limit';
            console.log(`开始执行交易: ${symbol}, 方向: ${direction}, 金额: ${usdtAmount} USDT, 形式: ${isLimitEntry ? '限价' : '市价'}, 委托价: ${limitPrice}`);

            // 限价单价格精度
            let formattedLimitPrice = null;
            if (isLimitEntry) {
                const priceStep = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize;
                formattedLimitPrice = Number(formatPrice(limitPrice, Number(priceStep)));
                if (!formattedLimitPrice || formattedLimitPrice <= 0) {
                    return { success: false, error: '缺少有效委托价，跳过该币种' };
                }
            }

            // 1. 检查保证金
            if (!await this.checkMargin(symbol, usdtAmount, minMargin)) {
                throw new Error('保证金检查失败');
            }
            await new Promise(resolve => setTimeout(resolve, 50));

            // 设置双向持仓
            await this.setupDualPositionMode()
            await new Promise(resolve => setTimeout(resolve, 50));

            // 2. 设置杠杆
            await retryRequest(() => this.client.setLeverage(symbol, leverage));
            console.log(`设置杠杆: ${leverage}x`);
            await new Promise(resolve => setTimeout(resolve, 50));

            // 3. 计算数量：限价单按委托价，市价单按当前价（口径：资金 × 杠杆 / 价格）
            const priceForSize = isLimitEntry
                ? formattedLimitPrice
                : await retryRequest(() => this.client.getCurrentPrice(symbol));
            await new Promise(resolve => setTimeout(resolve, 50));

            const quantity = await this.calculateQuantity(symbolInfo, usdtAmount, priceForSize, leverage);
            await new Promise(resolve => setTimeout(resolve, 50));

            console.log(`委托价/现价: ${priceForSize}, 计算数量: ${quantity}`);
            // 数量按精度向下取整为 0（下单金额相对价格过小）时返回失败结果，
            // 不能直接 return undefined——调用方会读取 result.success 抛异常并中断该轮剩余币种的下单
            if (Number(quantity) === 0) {
                return { success: false, error: '计算下单数量为0，跳过该币种' }
            }
            // 4. 检查当前持仓并平仓（如果需要）
            const currentPosition = await retryRequest(() => this.getCurrentPosition(symbol));
            await new Promise(resolve => setTimeout(resolve, 50));

            let isAddPosition = false; // 同向持仓 = 加仓
            if (currentPosition) {
                const currentDirection = currentPosition.positionSide;
                if ((currentDirection === 'LONG' && direction === 'SHORT') ||
                    (currentDirection === 'SHORT' && direction === 'LONG')) {
                    console.log(`发现反向持仓，先平仓: ${currentDirection}`);
                    await this.closePosition(symbol);
                    await new Promise(resolve => setTimeout(resolve, 50));
                } else {
                    isAddPosition = true;
                }
            }

            if (settingDirection === 'all' || settingDirection === direction) {
                const orderSide = direction === 'LONG' ? 'BUY' : 'SELL';
                let orderResult;

                if (isLimitEntry) {
                    // 5a. 限价单（GTC 一直有效，24小时未成交由 limitEntryManager 撤单）
                    orderResult = await retryRequest(() => this.client.placeLimitOrder(symbol, orderSide, quantity, formattedLimitPrice, 'GTC'));
                    console.log('限价单已挂出:', orderResult);
                } else {
                    // 5b. 市价单（顺势策略，突破即入场）
                    orderResult = await retryRequest(() => this.client.placeMarketOrder(symbol, orderSide, quantity));
                    console.log('市价单已成交:', orderResult);
                }
                await new Promise(resolve => setTimeout(resolve, 50));

                // 6. 止盈止损
                //    - 市价单已成交：立即按成交价挂止盈止损（与旧逻辑一致）
                //    - 限价单可能不成交，交易所不允许无持仓挂平仓条件单，成交后由 limitEntryManager 补挂
                let protectionOk = true;
                if (!isLimitEntry && !isAddPosition) {
                    try {
                        await this.setTakeProfitAndStopLoss(
                            symbolInfo,
                            priceForSize,
                            quantity,
                            takeProfitPercent,
                            stopLossPercent,
                            direction,
                        );
                        console.log('止盈止损已设置');
                    } catch (e) {
                        protectionOk = false;
                        console.error('市价入场后止盈止损设置失败（保留交易记录）:', e.message);
                    }
                }

                return {
                    success: true,
                    order: orderResult,
                    filledPrice: isLimitEntry ? formattedLimitPrice : priceForSize,
                    filledQuantity: quantity,
                    isAddPosition,
                    orderType: isLimitEntry ? 'limit' : 'market',
                    entryFilled: !isLimitEntry && (isAddPosition || protectionOk)
                };
            } else {
                return {
                    success: false,
                }
            }
        } catch (error) {
            console.error('交易执行失败:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 限价入场单成交后补挂止盈止损
     * @param {Object} params
     * @param {string} params.symbol - 交易对（含USDT）
     * @param {string} params.direction - LONG / SHORT
     * @param {string|number} params.entryPrice - 实际持仓均价
     * @param {number} params.takeProfitPercent - 止盈百分比
     * @param {number} params.stopLossPercent - 止损百分比
     * @returns {Promise<Object>}
     */
    async placeEntryProtection({symbol, direction, entryPrice, takeProfitPercent, stopLossPercent}) {
        const symbols = await this.getSymbolInfo();
        const symbolInfo = symbols.find(s => s.symbol === symbol);
        if (!symbolInfo) {
            throw new Error(`${symbol} 未找到交易对信息`);
        }
        return this.setTakeProfitAndStopLoss(
            symbolInfo,
            Number(entryPrice),
            0,
            Number(takeProfitPercent) || 0,
            Number(stopLossPercent) || 0,
            direction
        );
    }

    /**
     * 获取所有未成交挂单
     */
    async getOpenOrders() {
        return retryRequest(() => this.client.getOpenOrders());
    }

    /**
     * 撤销挂单
     */
    async cancelOrder(symbol, orderId) {
        return retryRequest(() => this.client.cancelOrder(symbol, orderId));
    }

    /**
     * 取消挂单
     * @param {string} symbol - 交易对
     * @param {string} type - 订单类型: 'all' 取消所有订单, 'stop_loss' 只取消止损订单, 'take_profit' 只取消止盈订单
     */
    async cancelOrders(symbol, type = 'all') {
        try {
            const openOrders = await this.client.getOpenOrders(symbol);
            let cancelledCount = 0;

            for (const order of openOrders) {
                // 根据类型过滤订单
                let shouldCancel = false;

                if (type === 'all') {
                    shouldCancel = true;
                } else if (type === 'stop_loss' && order.type === 'STOP_MARKET') {
                    shouldCancel = true;
                } else if (type === 'take_profit' && order.type === 'TAKE_PROFIT_MARKET') {
                    shouldCancel = true;
                }

                if (shouldCancel) {
                    await retryRequest(() => this.client.cancelOrder(symbol, order.orderId));
                    console.log(`已取消订单: ${order.orderId}, 类型: ${order.type}`);
                    cancelledCount++;
                }
            }

            return {success: true, cancelledCount: cancelledCount};
        } catch (error) {
            console.error('取消订单失败:', error.message);
            throw error;
        }
    }

    /**
     * 取消所有挂单
     */
    async cancelAllOrders(symbol) {
        return this.cancelOrders(symbol, 'all');
    }

    /**
     * 取消该合约所有 algo 条件单（止盈止损条件单均在 Algo Service）
     */
    async cancelAllAlgoOrders(symbol) {
        return retryRequest(() => this.client.cancelAllAlgoOpenOrders(symbol));
    }

    /**
     * 获取交易对信息
     */
    async getSymbolInfo() {
        try {
            const exchangeInfo = await retryRequest(() => this.client._sendRequest('GET', '/fapi/v1/exchangeInfo', {}));
            return exchangeInfo.symbols
        } catch (error) {
            console.error('获取交易对信息失败:', error.message);
            return []
        }
    }
}

module.exports = BinanceFuturesTrader;