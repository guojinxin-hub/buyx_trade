const {OKXClient} = require('./OKXFuturesClient');

class OKXFuturesTrader {
    constructor({apiKey, secretKey, passphrase, isSimulated = false}) {
        console.log("apiKey", {apiKey, secretKey, passphrase, isSimulated})
        this.client = new OKXClient({apiKey, secretKey, passphrase, isSimulated});
    }

    async getSymbolsInfo() {
        try {
            const instruments = await this.client.getCurrencyInfo();
            if (!instruments) {
                throw new Error(`获取币种信息出错`);
            }
            return instruments
        } catch (error) {
            throw new Error(`获取币种信息出错 ${error.message}`);
            return []
        }
    }


    /**
     * 检查保证金是否充足
     */
    async checkMargin(instId, usdtAmount, minMargin = 0) {
        try {
            const balance = await this.client.getAccountBalance();
            if (!balance) {
                throw new Error('无法获取账户余额');
            }

            const availableBalance = parseFloat(balance.available);

            // 检查最小保证金要求
            if (availableBalance < minMargin) {
                throw new Error(`保证金不足，可用余额 ${availableBalance} USDT 小于最小要求 ${minMargin} USDT`);
            }

            // 检查总保证金是否足够
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
     * 格式化价格到 tickSz 指定的精度
     * @param {number} price - 原始价格
     * @param {string|number} tickSz - 价格精度 (如 '0.01', '0.1', '0.001')
     * @param {string} rounding - 舍入方式: 'round'(四舍五入), 'floor'(向下), 'ceil'(向上)
     * @returns {number} 格式化后的价格
     */
    formatToPrecision(price, tickSz, rounding = 'round') {
        if (!price || !tickSz) return price;

        const tickSize = parseFloat(tickSz);
        if (tickSize === 0) return price;

        // 根据舍入方式计算
        let formatted;
        switch (rounding) {
            case 'floor': // 向下取整（保守）
                formatted = Math.floor(price / tickSize) * tickSize;
                break;
            case 'ceil': // 向上取整
                formatted = Math.ceil(price / tickSize) * tickSize;
                break;
            case 'round': // 四舍五入（默认）
            default:
                formatted = Math.round(price / tickSize) * tickSize;
        }

        // 计算需要保留的小数位数
        const decimals = this._getTickDecimals(tickSize);

        // 修复浮点数精度问题
        return parseFloat(formatted.toFixed(decimals));
    }

    /**
     * 获取 tickSize 的小数位数
     * @private
     */
    _getTickDecimals(tickSize) {
        if (tickSize === 0) return 0;

        const str = tickSize.toString();

        // 处理科学计数法 (如 1e-8)
        if (str.includes('e-')) {
            return parseInt(str.split('e-')[1]);
        }

        // 处理小数点
        if (str.includes('.')) {
            return str.split('.')[1].length;
        }

        // 整数情况 (如 1, 10, 100)
        return 0;
    }

    /**
     * 计算交易数量
     */
    calculateQuantity({symbolInfo, lastPrice, usdtAmount, leverage = 1}) {
        try {
            // 获取合约面值
            const ctVal = parseFloat(symbolInfo.ctVal);
            const minSz = parseFloat(symbolInfo.minSz); // 最小交易张数
            const lotSz = parseFloat(symbolInfo.lotSz); // 交易数量单位

            if (ctVal <= 0) {
                throw new Error(`合约面值无效: ${ctVal}`);
            }

            // 计算合约价值
            let contractValue;
            if (symbolInfo.ctType === 'linear') {
                // U本位合约：合约价值 = 价格 × 面值
                contractValue = lastPrice * ctVal;
            } else {
                // 币本位合约：合约价值 = 面值 / 价格
                contractValue = ctVal / lastPrice;
            }

            // 计算需要的张数
            let quantity = (usdtAmount * leverage) / contractValue;

            // 调整到合适的精度和最小单位
            quantity = this.adjustQuantityToPrecision(quantity, minSz, lotSz);

            console.log(`张数计算详情: 金额=${usdtAmount}, 杠杆=${leverage}, 面值=${ctVal}, 价格=${lastPrice}, 计算张数=${quantity}`);

            // 确保数量大于最小交易数量
            if (quantity < minSz) {
                throw new Error(`计算出的张数 ${quantity} 小于最小交易数量 ${minSz}`);
            }

            return parseFloat(quantity);

        } catch (error) {
            console.error('计算数量失败:', error.message);
            throw error;
        }
    }

    adjustQuantityToPrecision(quantity, minSz, lotSz) {
        // 使用小数位数控制精度
        const getMaxDecimals = (...numbers) => {
            return Math.max(...numbers.map(num => {
                const str = num.toString();
                return str.includes('.') ? str.split('.')[1].length : 0;
            }));
        };

        const maxDecimals = getMaxDecimals(quantity, minSz, lotSz);
        const precision = Math.min(maxDecimals, 8); // 限制最大精度为8位

        // 四舍五入到合适精度后再计算
        const roundToPrecision = (num, decimals) => {
            return parseFloat(num.toFixed(decimals));
        };

        const qRounded = roundToPrecision(quantity, precision);
        const lRounded = roundToPrecision(lotSz, precision);
        const mRounded = roundToPrecision(minSz, precision);

        // 计算倍数（使用更安全的除法）
        const multiples = qRounded / lRounded;

        // 使用 Math.trunc 而不是 Math.floor，避免负数问题
        const adjustedMultiples = Math.trunc(multiples);

        let adjustedQuantity = adjustedMultiples * lRounded;

        // 确保不小于最小交易数量
        if (adjustedQuantity < mRounded) {
            adjustedQuantity = mRounded;
        }

        // 最终精度调整
        adjustedQuantity = roundToPrecision(adjustedQuantity, precision);

        console.log(`保守调整: 输入=${quantity}, 输出=${adjustedQuantity}, 倍数=${adjustedMultiples}`);

        return adjustedQuantity;
    }

    async getPositionMode() {
        try {
            return await this.client.getPositionMode();
        } catch (e) {
            throw new Error(e.message)
        }
    }

    async setPositionMode() {
        try {
            await this.client.setPositionMode();
        } catch (e) {
            throw new Error(e.message)
        }
    }

    /**
     * 获取所有持仓
     */
    async getPositions(instId = '') {
        try {
            return await this.client.getPositions(instId);
        } catch (error) {
            console.error('获取持仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取当前持仓
     */
    async getCurrentPosition(instId) {
        try {
            const positions = await this.client.getPositions(instId);
            const position = positions.find((p) => p.instId === instId && p.ccy === 'USDT')
            if (position && parseFloat(position.pos) !== 0) {
                return {
                    instId: position.instId,
                    pos: parseFloat(position.pos),
                    posSide: position.posSide || (parseFloat(position.pos) > 0 ? 'buy' : 'sell'),
                    avgPx: parseFloat(position.avgPx),
                    lever: parseFloat(position.lever),
                    upl: parseFloat(position.upl),
                    liqPx: parseFloat(position.liqPx)
                };
            }
            return null;
        } catch (error) {
            console.error('获取持仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 平仓（使用市价单）
     */
    async closePosition(instId) {
        try {
            // 获取持仓信息
            const positions = await this.client.getPositions(instId);
            const position = positions.find((p) => p.instId === instId && parseFloat(p.pos) !== 0);

            if (!position) {
                console.log('没有持仓需要平仓');
                return null;
            }

            // 确定平仓方向和数量
            const pos = parseFloat(position.pos);
            const side = pos > 0 ? 'sell' : 'buy';
            const quantity = Math.abs(pos);

            console.log(`平仓: ${side.toUpperCase()} ${quantity} ${instId}`);

            // 执行市价平仓
            return await this.client.placeOrder({
                instId: instId,
                side: side,
                sz: quantity,
                ordType: 'market',
                tdMode: 'cross',
                posSide: position.posSide || 'net',
                reduceOnly: true
            });
        } catch (error) {
            console.error('平仓失败:', error.message);
            throw error;
        }
    }

    /**
     * 平仓（使用OKX专门的平仓接口）
     */
    async closePositionAPI(instId) {
        try {
            const positions = await this.client.getPositions(instId);
            const position = positions.find((p) => p.instId === instId && parseFloat(p.pos) !== 0);

            if (!position) {
                console.log('没有持仓需要平仓');
                return null;
            }

            console.log(`平仓: ${instId}, posSide=${position.posSide}, mgnMode=${position.mgnMode}`);

            return await this.client.closePositionAPI({
                instId: instId,
                posSide: position.posSide || 'net',
                mgnMode: position.mgnMode || 'cross'
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
            instId,
            usdtAmount,
            direction, // 'buy' or 'sell'
            leverage = 2,
            minMargin = 0,
            takeProfitPercent = 0,
            stopLossPercent = 0,
            symbolInfo,
            settingDirection = "all"
        } = params;

        try {
            console.log(`开始执行交易: ${instId}, 方向: ${direction}, 金额: ${usdtAmount} USDT, 杠杆: ${leverage}x`);
            // 1. 检查保证金
            await this.checkMargin(instId, usdtAmount, minMargin);
            await new Promise(resolve => setTimeout(resolve, 100));
            // 2. 设置杠杆倍数
            await this.client.setLeverage(instId, leverage);
            console.log(`设置杠杆: ${leverage}x`);
            await new Promise(resolve => setTimeout(resolve, 100));


            // 获取当前市价单价格，并且计算止盈止损价格，根据价格获取张数
            // 3. 获取当前价格和计算数量
            const ticker = await this.client.getTicker(instId);
            const currentPrice = parseFloat(ticker.last);

            // 计算止盈止损价格
            let takeProfitPrice, stopLossPrice;

            if (direction.toLowerCase() === 'buy') {
                takeProfitPrice = currentPrice * (1 + takeProfitPercent / 100);
                stopLossPrice = currentPrice * (1 - stopLossPercent / 100);
            } else {
                takeProfitPrice = currentPrice * (1 - takeProfitPercent / 100);
                stopLossPrice = currentPrice * (1 + stopLossPercent / 100);
            }
            if (takeProfitPrice < 0) {
                takeProfitPrice = 0
            }
            if (stopLossPrice < 0) {
                stopLossPrice = 0
            }
            // 格式化价格到正确精度
            console.log(`当前价格 ${currentPrice} 止盈价格: ${takeProfitPrice}, 止损价格: ${stopLossPrice} 方向：${direction} ,USDT: ${usdtAmount}`);
            const size = this.calculateQuantity({symbolInfo, lastPrice: currentPrice, usdtAmount, leverage})

            const currentPosition = await this.getCurrentPosition(instId);
            let order = null;
            if (currentPosition) {
                const currentDirection = currentPosition.pos > 0 ? "buy" : "sell";
                if ((currentDirection === 'buy' && direction === 'sell') ||
                    (currentDirection === 'sell' && direction === 'buy')) {
                    console.log(`发现反向持仓，先平仓: ${currentDirection}`);
                    await this.client.closePosition(currentPosition);
                    // 等待平仓完成
                    if (settingDirection === "all" || direction === settingDirection) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        order = await this.client.placeOrderWithUsdt({
                            instId,
                            side: direction,
                            size: size, // 100 USDT
                            attachAlgoOrds: {
                                slTriggerPx: stopLossPrice, // 止损触发价
                                slOrdPx: -1, // -1表示市价止损
                                slTriggerPxType: 'last', // 最新价触发
                                tpOrdPx: -1, // 止盈价
                                tpTriggerPx: takeProfitPrice, // 止盈价
                                tpTriggerPxType: 'last',
                            }
                        });
                    }
                } else if (currentPosition.pos > 0 && direction === "buy" || currentPosition.pos < 0 && direction === "sell") {
                    // 同向持仓：加仓资金与次数已由包装层按加仓规则决定，此处直接加仓
                    if (settingDirection === "all" || direction === settingDirection) {
                        console.log('同向持仓，执行加仓');
                        order = await this.client.placeOrderWithUsdt({
                            instId,
                            side: direction,
                            size: size, // 100 USDT
                            attachAlgoOrds: {
                                slTriggerPx: stopLossPrice, // 止损触发价
                                slOrdPx: -1, // -1表示市价止损
                                slTriggerPxType: 'last', // 最新价触发
                                tpOrdPx: -1, // 止盈价
                                tpTriggerPx: takeProfitPrice, // 止盈价
                                tpTriggerPxType: 'last',
                            }
                        });
                    }
                }
            } else {
                if (settingDirection === "all" || direction === settingDirection) {
                    order = await this.client.placeOrderWithUsdt({
                        instId,
                        side: direction,
                        size: size, // 100 USDT
                        attachAlgoOrds: {
                            slTriggerPx: stopLossPrice, // 止损触发价
                            slOrdPx: -1, // -1表示市价止损
                            slTriggerPxType: 'last', // 最新价触发
                            tpOrdPx: -1, // 止盈价
                            tpTriggerPx: takeProfitPrice, // 止盈价
                            tpTriggerPxType: 'last',
                        }
                    });
                }
            }
            return {
                success: true,
                order,
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
    async cancelAllOrders(instId) {
        try {
            const result = await this.client.cancelAllOrders(instId);
            console.log(`已取消 ${instId} 的所有挂单`);
            return result;
        } catch (error) {
            console.error('取消订单失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取账户信息
     */
    async getAccountInfo() {
        try {
            const balance = await this.client.getAccountBalance();
            const positions = await this.client.getPositions();

            return {
                balance: balance,
                positions: positions.map(pos => ({
                    instId: pos.instId,
                    pos: parseFloat(pos.pos),
                    avgPx: parseFloat(pos.avgPx),
                    upl: parseFloat(pos.upl)
                }))
            };
        } catch (error) {
            console.error('获取账户信息失败:', error.message);
            throw error;
        }
    }
}

module.exports = OKXFuturesTrader;