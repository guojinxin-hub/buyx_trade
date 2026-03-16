const crypto = require('crypto');
const https = require('https');

class BinanceFuturesClient {
    constructor(apiKey, apiSecret, isTestnet = false) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseURL = isTestnet
            ? 'https://testnet.binancefuture.com'
            : 'https://fapi.binance.com';
        this.recvWindow = 5000;
        // 添加请求队列和延迟机制
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.requestDelay = 100; // 请求间隔时间（毫秒），可根据需要调整
    }

    // 生成签名
    _generateSignature(queryString) {
        return crypto
            .createHmac('sha256', this.apiSecret)
            .update(queryString)
            .digest('hex');
    }

    // 发送HTTP请求
    async _sendRequest(method, endpoint, params = {}, isSigned = false) {
        // 将请求添加到队列中
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                method,
                endpoint,
                params,
                isSigned,
                resolve,
                reject
            });

            // 如果当前没有在处理队列，则开始处理
            if (!this.isProcessingQueue) {
                this._processRequestQueue();
            }
        });
    }

    // 处理请求队列
    async _processRequestQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift();
            const { method, endpoint, params, isSigned, resolve, reject } = request;

            try {
                const result = await this._executeRequest(method, endpoint, params, isSigned);
                resolve(result);
            } catch (error) {
                reject(error);
            }

            // 添加延迟，避免请求过于频繁
            if (this.requestQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.requestDelay));
            }
        }

        this.isProcessingQueue = false;
    }

    // 执行单个请求
    async _executeRequest(method, endpoint, params = {}, isSigned = false) {
        return new Promise((resolve, reject) => {
            let queryString = Object.keys(params)
                .map(key => `${key}=${encodeURIComponent(params[key])}`)
                .join('&');

            if (isSigned) {
                const timestamp = Date.now();
                const signatureParams = {
                    ...params,
                    timestamp,
                    recvWindow: this.recvWindow
                };

                const signatureQuery = Object.keys(signatureParams)
                    .sort()
                    .map(key => `${key}=${encodeURIComponent(signatureParams[key])}`)
                    .join('&');

                const signature = this._generateSignature(signatureQuery);
                queryString = `${signatureQuery}&signature=${signature}`;
            }

            const options = {
                hostname: new URL(this.baseURL).hostname,
                port: 443,
                path: `${endpoint}${queryString ? '?' + queryString : ''}`,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': this.apiKey
                },
                timeout: 100000 // 添加超时时间
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.code) {
                            reject(new Error(`Binance API Error: ${parsed.msg} (code: ${parsed.code})`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (error) {
                        reject(new Error(`Error parsing response: ${error.message}, data: ${data}`));
                    }
                });
            });

            req.on('error', (error) => {
                console.error(`HTTPS request error: ${error}`);
                console.error(`Error details:`, error);
                if (error.errors) {
                    console.error(`Sub-errors:`, error.errors);
                }
                reject(error);
            });

            req.on('timeout', () => {
                console.warn(`Request timeout: ${options.method} ${options.path}`);
                req.destroy(); // 销毁请求连接
                reject(new Error('Request timeout'));
            });

            req.write(''); // 确保发送请求体（即使是空的）
            req.end();
        });
    }

    // 获取账户信息
    async getAccountInfo() {
        return this._sendRequest('GET', '/fapi/v2/account', {}, true);
    }

    // 设置双向持仓模式
    async setPositionMode(dualSidePosition) {
        /**
         * 设置持仓模式
         * @param {boolean} dualSidePosition - true: 双向持仓模式, false: 单向持仓模式
         * 注意：更改持仓模式时，必须没有未平仓仓位和挂单
         */
        return this._sendRequest('POST', '/fapi/v1/positionSide/dual', {
            dualSidePosition: dualSidePosition.toString()
        }, true);
    }

    // 获取当前持仓模式
    async getPositionMode() {
        /**
         * 获取当前持仓模式
         * @returns {Object} - 包含dualSidePosition字段
         */
        return this._sendRequest('GET', '/fapi/v1/positionSide/dual', {}, true);
    }

    // 获取当前价格
    async getCurrentPrice(symbol) {
        const data = await this._sendRequest('GET', '/fapi/v1/ticker/price', {symbol});
        return parseFloat(data.price);
    }

    // 设置杠杆
    async setLeverage(symbol, leverage) {
        return this._sendRequest('POST', '/fapi/v1/leverage', {
            symbol,
            leverage
        }, true);
    }

    // 获取订单信息
    async getOrder(symbol, orderId) {
        return this._sendRequest('GET', '/fapi/v1/order', {
            symbol,
            orderId
        }, true);
    }

    // 撤销订单
    async cancelOrder(symbol, orderId) {
        return this._sendRequest('DELETE', '/fapi/v1/order', {
            symbol,
            orderId
        }, true);
    }
    async getOpenOrders(symbol) {
        return this._sendRequest('GET', '/fapi/v1/openOrders', { symbol }, true);
    }
    // 通用下单方法
    async placeOrder(symbol, orderParams) {
        const params = {
            symbol,
            ...orderParams
        };

        // 处理特殊参数
        if (params.closePosition === 'true') {
            params.closePosition = true;
            // 当使用closePosition时，不需要quantity参数
            delete params.quantity;
        }

        return this._sendRequest('POST', '/fapi/v1/order', params, true);
    }

    async placeAlgoOrder(symbol, orderParams) {
        const params = {
            symbol,
            algoType: "CONDITIONAL",
            workingType: 'MARK_PRICE',
            positionSide: "BOTH",
            ...orderParams
        };

        // 处理特殊参数
        if (params.closePosition === 'true') {
            // 当使用closePosition时，不需要quantity参数
            delete params.quantity;
        }

        return this._sendRequest('POST', '/fapi/v1/algoOrder', params, true);
    }

    // 市价单
    async placeMarketOrder(symbol, side, quantity, reduceOnly = false) {
        const params = {
            side,
            type: 'MARKET',
            quantity: parseFloat(quantity),
            reduceOnly: reduceOnly
        };

        return this.placeOrder(symbol, params);
    }

    async placeLimitOrder(symbol, side, quantity, price, timeInForce = 'GTC', reduceOnly = false) {
        const params = {
            side,
            type: 'LIMIT',
            quantity: parseFloat(quantity),
            price: parseFloat(price),
            timeInForce,
            reduceOnly: reduceOnly
        };

        return this.placeOrder(symbol, params);
    }

    // 获取订单平均成交价
    async getOrderAvgPrice(symbol, orderId) {
        try {
            const order = await this.getOrder(symbol, orderId);

            if (order.status === 'FILLED' && order.avgPrice) {
                return parseFloat(order.avgPrice);
            }

            if (order.fills && order.fills.length > 0) {
                let totalQuantity = 0;
                let totalValue = 0;

                for (const fill of order.fills) {
                    const qty = parseFloat(fill.qty);
                    const price = parseFloat(fill.price);
                    totalQuantity += qty;
                    totalValue += qty * price;
                }

                if (totalQuantity > 0) {
                    return totalValue / totalQuantity;
                }
            }

            return await this.getCurrentPrice(symbol);

        } catch (error) {
            console.error('获取订单成交价时出错:', error);
            return await this.getCurrentPrice(symbol);
        }
    }


}

module.exports = BinanceFuturesClient;