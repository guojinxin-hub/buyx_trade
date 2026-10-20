const {BybitClient} = require('./BybitClient');
const {isEmpty} = require("lodash");

class BybitFuturesTrader {
    constructor({apiKey, secretKey, isTestnet = false}) {
        console.log("Bybit Trader 初始化", {apiKey: apiKey?.substring(0, 8) + '...', isTestnet});
        this.client = new BybitClient({apiKey, secretKey, isTestnet});
    }

    /**
     * 获取所有交易对信息
     */
    async getSymbolsInfo() {
        try {
            const instruments = await this.client.getAllInstruments();
            if (!instruments || instruments.length === 0) {
                throw new Error('获取币种信息出错');
            }
            return instruments;
        } catch (error) {
            throw new Error(`获取币种信息出错: ${error.message}`);
        }
    }

    /**
     * 检查保证金是否充足
     */
    async checkMargin(symbol, usdtAmount, minMargin = 0) {
        try {
            const balance = await this.client.getAccountBalance('USDT');
            if (!balance) {
                throw new Error('无法获取账户余额');
            }

            const availableBalance = parseFloat(balance.available);

            if (availableBalance < minMargin) {
                throw new Error(`保证金不足，可用余额 ${availableBalance} USDT 小于最小要求 ${minMargin} USDT`);
            }

            if ((availableBalance - minMargin) < usdtAmount) {
                throw new Error(`保证金不足，需要 ${usdtAmount} USDT，但只有 ${availableBalance} USDT 可用`);
            }

            console.log(`保证金检查通过: 可用=${availableBalance} USDT`);
            return true;
        } catch (error) {
            console.error('检查保证金失败:', error.message);
            throw error;
        }
    }

    /**
     * 格式化价格到 tickSize 指定的精度
     */
    formatToPrecision(price, tickSize, rounding = 'round') {
        if (!price || !tickSize) return price;

        const tick = parseFloat(tickSize);
        if (tick === 0) return price;

        let formatted;
        switch (rounding) {
            case 'floor':
                formatted = Math.floor(price / tick) * tick;
                break;
            case 'ceil':
                formatted = Math.ceil(price / tick) * tick;
                break;
            case 'round':
            default:
                formatted = Math.round(price / tick) * tick;
        }

        const decimals = this._getTickDecimals(tick);
        return parseFloat(formatted.toFixed(decimals));
    }

    /**
     * 获取 tickSize 的小数位数
     * @private
     */
    _getTickDecimals(tickSize) {
        if (tickSize === 0) return 0;
        const str = tickSize.toString();
        if (str.includes('e-')) {
            return parseInt(str.split('e-')[1]);
        }
        if (str.includes('.')) {
            return str.split('.')[1].length;
        }
        return 0;
    }

    /**
     * 计算交易数量
     */
    calculateQuantity({symbolInfo, lastPrice, usdtAmount, leverage = 1}) {
        try {
            // 获取合约面值和最小交易数量
            const lotSizeFilter = symbolInfo.lotSizeFilter;
            const minOrderQty = parseFloat(lotSizeFilter?.minOrderQty || 0.001);
            const qtyStep = parseFloat(lotSizeFilter?.qtyStep || 0.001);

            // 合约价值 = 价格 × 数量（USDT永续合约）
            // 所需张数 = (USDT金额 × 杠杆) / 价格
            let quantity = (usdtAmount * leverage) / lastPrice;

            // 调整到合适的精度和最小单位
            quantity = this.adjustQuantityToPrecision(quantity, minOrderQty, qtyStep);

            console.log(`张数计算详情: 金额=${usdtAmount}, 杠杆=${leverage}, 价格=${lastPrice}, 计算数量=${quantity}`);

            if (quantity < minOrderQty) {
                throw new Error(`计算出的数量 ${quantity} 小于最小交易数量 ${minOrderQty}`);
            }

            return parseFloat(quantity.toFixed(8));
        } catch (error) {
            console.error('计算数量失败:', error.message);
            throw error;
        }
    }

    /**
     * 调整数量到交易所要求的精度
     */
    adjustQuantityToPrecision(quantity, minQty, qtyStep) {
        // 计算需要保留的小数位数
        const getDecimals = (num) => {
            const str = num.toString();
            return str.includes('.') ? str.split('.')[1].length : 0;
        };

        const maxDecimals = Math.max(getDecimals(minQty), getDecimals(qtyStep));
        const precision = Math.min(maxDecimals, 8);

        const roundToPrecision = (num, decimals) => {
            return parseFloat(num.toFixed(decimals));
        };

        const qRounded = roundToPrecision(quantity, precision);
        const stepRounded = roundToPrecision(qtyStep, precision);
        const minRounded = roundToPrecision(minQty, precision);

        // 计算倍数
        const multiples = qRounded / stepRounded;
        const adjustedMultiples = Math.floor(multiples);
        let adjustedQuantity = adjustedMultiples * stepRounded;

        if (adjustedQuantity < minRounded) {
            adjustedQuantity = minRounded;
        }

        adjustedQuantity = roundToPrecision(adjustedQuantity, precision);

        console.log(`数量调整: 输入=${quantity}, 输出=${adjustedQuantity}, 倍数=${adjustedMultiples}`);
        return adjustedQuantity;
    }

    /**
     * 获取持仓模式
     */
    async getPositionMode() {
        try {
            return await this.client.getPositionMode();
        } catch (e) {
            throw new Error(e.message);
        }
    }

    /**
     * 设置持仓模式为单向持仓
     */
    async setPositionMode() {
        try {
            await this.client.setPositionMode(0);
        } catch (e) {
            throw new Error(e.message);
        }
    }

    /**
     * 获取当前持仓
     */
    async getCurrentPosition(symbol) {
        try {
            const positions = await this.client.getPositions(symbol);
            // 过滤出有持仓的仓位
            const position = positions.find(p =>
                p.symbol === symbol && parseFloat(p.size) !== 0
            );

            if (position && parseFloat(position.size) !== 0) {
                const size = parseFloat(position.size);
                return {
                    symbol: position.symbol,
                    pos: size,
                    side: position.side,
                    avgPrice: parseFloat(position.avgPrice),
                    leverage: parseFloat(position.leverage),
                    unrealisedPnl: parseFloat(position.unrealisedPnl),
                    liqPrice: parseFloat(position.liqPrice),
                    positionIdx: position.positionIdx || 0
                };
            }
            return null;
        } catch (error) {
            console.error('获取持仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 平仓
     */
    async closePosition(symbol) {
        try {
            const positions = await this.client.getPositions(symbol);
            const position = positions.find(p =>
                p.symbol === symbol && parseFloat(p.size) !== 0
            );

            if (!position) {
                console.log('没有持仓需要平仓');
                return null;
            }

            const size = parseFloat(position.size);
            const side = position.side === 'Buy' ? 'Sell' : 'Buy';
            const quantity = Math.abs(size).toString();

            console.log(`平仓: ${side} ${quantity} ${symbol}`);

            return await this.client.placeOrder({
                symbol: symbol,
                side: side,
                orderType: 'Market',
                qty: quantity,
                positionIdx: position.positionIdx || 0,
                reduceOnly: true
            });
        } catch (error) {
            console.error('平仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 执行交易
     */
    async executeTrade(params) {
        const {
            symbol,
            usdtAmount,
            direction, // 'Buy' or 'Sell'
            leverage = 2,
            minMargin = 0,
            takeProfitPercent = 0,
            stopLossPercent = 0,
            symbolInfo,
            settingDirection,
            limitPrice,
            entryType = 'market'
        } = params;

        try {
            const isLimitEntry = entryType === 'limit';
            console.log(`开始执行交易: ${symbol}, 方向: ${direction}, 金额: ${usdtAmount} USDT, 杠杆: ${leverage}x, 形式: ${isLimitEntry ? '限价' : '市价'}, 委托价: ${limitPrice}`);

            // 委托价：限价单用引擎下发的委托价；市价单用最新价（仅用于计算数量与止盈止损基准）
            const priceFilter = symbolInfo.priceFilter;
            const tickSize = parseFloat(priceFilter?.tickSize || 0.01);
            let formattedLimitPrice = null;
            let priceForSize;
            if (isLimitEntry) {
                formattedLimitPrice = this.formatToPrecision(Number(limitPrice), priceFilter?.tickSize);
                if (!formattedLimitPrice || Number(formattedLimitPrice) <= 0) {
                    return {success: false, error: '缺少有效委托价，跳过该币种'};
                }
                priceForSize = formattedLimitPrice;
            } else {
                const ticker = await this.client.getTicker(symbol);
                priceForSize = parseFloat(ticker.lastPrice);
            }

            // 1. 检查保证金
            await this.checkMargin(symbol, usdtAmount, minMargin);
            await this._delay(100);

            // 2. 设置杠杆倍数
            await this.client.setLeverage(symbol, leverage, leverage);
            console.log(`设置杠杆: ${leverage}x`);
            await this._delay(100);

            // 获取当前持仓（判断反手 / 加仓）
            const currentPosition = await this.getCurrentPosition(symbol);
            await this._delay(100);
            const hasPosition = !isEmpty(currentPosition);
            let isReverse = false;
            let isAddPosition = false;
            if (hasPosition) {
                const currentDirection = currentPosition.side;
                isReverse = (currentDirection === 'Buy' && direction === 'Sell') ||
                    (currentDirection === 'Sell' && direction === 'Buy');
                isAddPosition = !isReverse;
            }

            // 止盈止损以委托价（限价）/最新价（市价）为基准
            let takeProfitPrice, stopLossPrice;

            if (direction === 'Buy') {
                takeProfitPrice = priceForSize * (1 + takeProfitPercent / 100);
                stopLossPrice = priceForSize * (1 - stopLossPercent / 100);
            } else {
                takeProfitPrice = priceForSize * (1 - takeProfitPercent / 100);
                stopLossPrice = priceForSize * (1 + stopLossPercent / 100);
            }

            if (takeProfitPrice < 0) takeProfitPrice = 0;
            if (stopLossPrice < 0) stopLossPrice = 0;

            // 格式化价格精度
            takeProfitPrice = this.formatToPrecision(takeProfitPrice, tickSize);
            stopLossPrice = this.formatToPrecision(stopLossPrice, tickSize);

            console.log(`委托价/现价 ${priceForSize}, 止盈价格: ${takeProfitPrice}, 止损价格: ${stopLossPrice}`);

            // 止盈止损仅在"配置了百分比"且"非加仓"时随单提交：
            // - 百分比为 0 时不再提交（否则 TP=当前价会被 Bybit 判为非法价而整单被拒）
            // - 加仓不重设，保留原仓位的止盈止损（避免按加仓价把原止损整体挪走）
            const buildTpSl = (skip) => {
                const tpSl = {};
                if (skip) return tpSl;
                if (takeProfitPercent > 0 && Number(takeProfitPrice) > 0) tpSl.takeProfit = takeProfitPrice.toString();
                if (stopLossPercent > 0 && Number(stopLossPrice) > 0) tpSl.stopLoss = stopLossPrice.toString();
                return tpSl;
            };

            // 计算数量
            const quantity = this.calculateQuantity({
                symbolInfo,
                lastPrice: priceForSize,
                usdtAmount,
                leverage
            });

            const orderType = isLimitEntry ? 'Limit' : 'Market';
            const orderPrice = isLimitEntry ? formattedLimitPrice.toString() : undefined;

            // Bybit 限价单：价格 + GTC；附带止盈止损在成交开仓后生效
            if (hasPosition) {
                // 反向持仓：先平仓再开仓（新仓位，正常挂止盈止损）
                if (isReverse) {
                    console.log(`发现反向持仓，先平仓: ${currentPosition.side}`);
                    await this.closePosition(symbol);
                    await this._delay(100);

                    if (settingDirection === "all" || direction === settingDirection) {
                        const order = await this.client.placeOrder({
                            symbol: symbol,
                            side: direction,
                            orderType: orderType,
                            qty: quantity.toString(),
                            price: orderPrice,
                            positionIdx: 0,
                            ...buildTpSl(false)
                        });
                        console.log('开仓结果:', order);
                        return {
                            success: true,
                            order: order,
                            filledPrice: priceForSize,
                            orderType: isLimitEntry ? 'limit' : 'market',
                            filledQuantity: quantity,
                            isAddPosition: false
                        };
                    }
                }
                // 同向持仓：加仓资金与次数已由包装层按加仓规则决定，此处直接加仓并保留原止盈止损
                else if (isAddPosition) {
                    if (settingDirection === "all" || direction === settingDirection) {
                        console.log('同向持仓，执行加仓（保留原有止盈止损）');
                        const order = await this.client.placeOrder({
                            symbol: symbol,
                            side: direction,
                            orderType: orderType,
                            qty: quantity.toString(),
                            price: orderPrice,
                            positionIdx: 0,
                            ...buildTpSl(true)
                        });
                        console.log('加仓结果:', order);
                        return {
                            success: true,
                            order: order,
                            filledPrice: priceForSize,
                            orderType: isLimitEntry ? 'limit' : 'market',
                            filledQuantity: quantity,
                            isAddPosition: true
                        };
                    }
                }
            } else {
                // 无持仓，直接开仓
                if (settingDirection === "all" || direction === settingDirection) {
                    const order = await this.client.placeOrder({
                        symbol: symbol,
                        side: direction,
                        orderType: orderType,
                        qty: quantity.toString(),
                        price: orderPrice,
                        positionIdx: 0,
                        ...buildTpSl(false)
                    });
                    console.log('开仓结果:', order);
                    return {
                        success: true,
                        order: order,
                        filledPrice: priceForSize,
                        orderType: isLimitEntry ? 'limit' : 'market',
                        filledQuantity: quantity,
                        isAddPosition: false
                    };
                }
            }

            return {
                success: true,
                order: null
            };
        } catch (error) {
            console.error('交易执行失败:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 取消所有挂单
     */
    async cancelAllOrders(symbol) {
        try {
            const result = await this.client.cancelAllOrders(symbol);
            console.log(`已取消 ${symbol} 的所有挂单`);
            return result;
        } catch (error) {
            console.error('取消订单失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取持仓列表（兼容OKX格式）
     */
    async getPositions(symbol) {
        try {
            const positions = await this.client.getPositions(symbol);
            return positions.map(pos => ({
                instId: pos.symbol,
                pos: pos.size,
                side: pos.side,
                posSide: parseFloat(pos.size) > 0 ? 'long' : 'short',
                avgPx: pos.avgPrice,
                lever: pos.leverage,
                upl: pos.unrealisedPnl,
                liqPx: pos.liqPrice,
                markPx: pos.markPrice,
                last: pos.markPrice,
                mgn: pos.positionIM
            }));
        } catch (error) {
            console.error('获取持仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取账户信息
     */
    async getAccountInfo() {
        try {
            const balance = await this.client.getAccountBalance('USDT');
            const positions = await this.client.getPositions();

            return {
                balance: balance,
                positions: positions.filter(p => parseFloat(p.size) !== 0).map(pos => ({
                    instId: pos.symbol,
                    pos: parseFloat(pos.size),
                    avgPx: parseFloat(pos.avgPrice),
                    upl: parseFloat(pos.unrealisedPnl)
                }))
            };
        } catch (error) {
            console.error('获取账户信息失败:', error.message);
            throw error;
        }
    }

    /**
     * 延迟函数
     * @private
     */
    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = BybitFuturesTrader;