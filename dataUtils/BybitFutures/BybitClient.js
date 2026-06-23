const axios = require('axios');
const crypto = require('crypto');

class BybitClient {
    /**
     * 初始化Bybit客户端
     * @param {Object} config - 配置对象
     * @param {string} config.apiKey - API Key
     * @param {string} config.secretKey - Secret Key
     * @param {string} config.baseURL - API基础URL (默认: https://api.bybit.com)
     * @param {boolean} config.isTestnet - 是否测试网 (默认: false)
     */
    constructor(config) {
        this.apiKey = config.apiKey;
        this.secretKey = config.secretKey;
        this.baseURL = config.isTestnet
            ? 'https://api-testnet.bybit.com'
            : (config.baseURL || 'https://api.bybit.com');
        this.isTestnet = config.isTestnet || false;

        // 创建axios实例
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // 请求拦截器 - 添加签名
        this.client.interceptors.request.use((config) => {
            if (this.apiKey && this.secretKey) {
                // 1. 为每个请求生成新的时间戳
                const timestamp = Date.now().toString();
                const recvWindow = '5000';

                // 2. 构建参数字符串 (paramsString) 和 准备请求数据
                let paramsString = '';
                let requestData = '';

                if (config.method.toUpperCase() === 'GET') {
                    // GET: 将参数拼接为原始查询字符串，不排序
                    if (config.params && Object.keys(config.params).length > 0) {
                        const paramsList = [];
                        for (const [key, value] of Object.entries(config.params)) {
                            paramsList.push(`${key}=${value}`);
                        }
                        paramsString = paramsList.join('&');
                        // 签名用的就是 paramsString
                        requestData = ''; // GET请求 body 为空
                        // 修改URL，后面会用
                        config.url = `${config.url}?${paramsString}`;
                    }
                    delete config.params; // 清除params，因为已拼接到URL
                } else if (config.method.toUpperCase() === 'POST') {
                    // POST: 使用JSON字符串
                    if (config.data) {
                        paramsString = JSON.stringify(config.data);
                        requestData = config.data;
                    }
                }

                // 3. 构建签名明文: timestamp + apiKey + recvWindow + paramsString
                const signaturePayload = timestamp + this.apiKey + recvWindow + paramsString;
                // 4. 生成签名 (HMAC-SHA256, 输出为十六进制)
                const signature = crypto
                    .createHmac('sha256', this.secretKey)
                    .update(signaturePayload)
                    .digest('hex');

                config.headers = {
                    ...config.headers,
                    'X-BAPI-API-KEY': this.apiKey,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-RECV-WINDOW': recvWindow,
                    'X-BAPI-SIGN-TYPE': '2',
                    'X-BAPI-SIGN': signature,
                };

                // 6. 设置POST请求的body
                if (config.method === 'POST') {
                    config.data = requestData;
                }
            }
            return config;
        });
        // 响应拦截器
        this.client.interceptors.response.use(
            (response) => {
                if (response.data.retCode !== 0) {
                    throw new Error(`API Error: ${response.data.retMsg} (${response.data.retCode})`);
                }
                return response.data;
            },
            (error) => {
                if (error.response) {
                    throw new Error(`HTTP Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
                }
                throw error;
            }
        );

        // 缓存币种信息
        this.instrumentCache = new Map();
    }

    /**
     * 获取交易产品信息
     * @param {string} symbol - 产品ID (如: ETHUSDT)
     * @returns {Promise<Object>} 产品信息
     */
    async getInstrumentInfo(symbol) {
        if (this.instrumentCache.has(symbol)) {
            return this.instrumentCache.get(symbol);
        }

        try {
            const response = await this.client.get('/v5/market/instruments-info', {
                params: {
                    category: 'linear',
                    symbol: symbol
                }
            });

            if (response.result.list && response.result.list.length > 0) {
                const instrument = response.result.list[0];
                this.instrumentCache.set(symbol, instrument);
                return instrument;
            }
            throw new Error(`Instrument not found: ${symbol}`);
        } catch (error) {
            throw new Error(`Failed to get instrument info: ${error.message}`);
        }
    }

    /**
     * 获取所有交易产品信息
     * @returns {Promise<Array>} 产品信息列表
     */
    async getAllInstruments() {
        try {
            const response = await this.client.get('/v5/market/instruments-info', {
                params: {
                    category: 'linear'
                }
            });
            return response.result.list || [];
        } catch (error) {
            throw new Error(`Failed to get instruments: ${error.message}`);
        }
    }

    /**
     * 获取行情信息
     * @param {string} symbol - 产品ID
     * @returns {Promise<Object>} 行情数据
     */
    async getTicker(symbol) {
        try {
            const response = await this.client.get('/v5/market/tickers', {
                params: {
                    category: 'linear',
                    symbol: symbol
                }
            });
            return response.result.list[0];
        } catch (error) {
            throw new Error(`Failed to get ticker: ${error.message}`);
        }
    }

    /**
     * 下单
     * @param {Object} params - 下单参数
     * @param {string} params.symbol - 产品ID
     * @param {string} params.side - 买卖方向 (Buy/Sell)
     * @param {string} params.orderType - 订单类型 (Market/Limit)
     * @param {string} params.positionIdx - 持仓方向 (0: 单向持仓, 1: 买方向, 2: 卖方向)
     * @param {string} params.qty - 数量
     * @param {string} [params.price] - 价格(限价单必填)
     * @param {boolean} [params.reduceOnly] - 是否只减仓
     * @param {Object} [params.takeProfit] - 止盈设置
     * @param {Object} [params.stopLoss] - 止损设置
     * @returns {Promise<Object>} 订单结果
     */
    async placeOrder(params) {
        try {
            const orderData = {
                category: 'linear',
                symbol: params.symbol,
                side: params.side,
                orderType: params.orderType,
                qty: params.qty,
                positionIdx: params.positionIdx || 0,
                timeInForce: 'GTC'
            };

            if (params.price) {
                // 验证并处理价格精度
                const instrument = await this.getInstrumentInfo(params.symbol);
                const priceFilter = instrument.priceFilter;
                const tickSize = parseFloat(priceFilter.tickSize);
                const decimals = this._getTickDecimals(tickSize);
                orderData.price = parseFloat(params.price).toFixed(decimals);
            }

            if (params.reduceOnly) {
                orderData.reduceOnly = true;
            }

            // 添加止盈止损
            if (params.takeProfit || params.stopLoss) {
                const tpSlParams = {};
                if (params.takeProfit) {
                    tpSlParams.takeProfit = params.takeProfit;
                }
                if (params.stopLoss) {
                    tpSlParams.stopLoss = params.stopLoss;
                }
                orderData.positionIdx = params.positionIdx || 0;
                Object.assign(orderData, tpSlParams);
            }

            const response = await this.client.post('/v5/order/create', orderData);
            return response.result;
        } catch (error) {
            throw new Error(`Failed to place order: ${error.message}`);
        }
    }

    /**
     * 设置止盈止损
     * @param {Object} params - 参数
     * @param {string} params.symbol - 产品ID
     * @param {string} params.side - 方向
     * @param {string} params.positionIdx - 持仓方向
     * @param {string} [params.takeProfit] - 止盈价
     * @param {string} [params.stopLoss] - 止损价
     * @returns {Promise<Object>}
     */
    async setTradingStop(params) {
        try {
            const data = {
                category: 'linear',
                symbol: params.symbol,
                side: params.side,
                positionIdx: params.positionIdx || 0
            };

            if (params.takeProfit) {
                data.takeProfit = params.takeProfit;
            }
            if (params.stopLoss) {
                data.stopLoss = params.stopLoss;
            }

            const response = await this.client.post('/v5/position/trading-stop', data);
            return response.result;
        } catch (error) {
            throw new Error(`Failed to set trading stop: ${error.message}`);
        }
    }

    /**
     * 获取持仓信息
     * @param {string} [symbol] - 产品ID，不传则获取所有持仓
     * @returns {Promise<Array>} 持仓列表
     */
    async getPositions(symbol) {
        try {
            const params = {
                category: 'linear',
                settleCoin: 'USDT'
            };
            if (symbol) {
                params.symbol = symbol;
            }
            const response = await this.client.get('/v5/position/list', { params });
            return response.result.list || [];
        } catch (error) {
            throw new Error(`Failed to get positions: ${error.message}`);
        }
    }

    /**
     * 获取账户余额
     * @param {string} [coin] - 币种，不传则获取所有币种余额
     * @returns {Promise<Object>} 账户余额
     */
    async getAccountBalance(coin) {
        try {
            const params = { accountType: 'UNIFIED' };
            if (coin) {
                params.coin = coin;
            }
            const response = await this.client.get('/v5/account/wallet-balance', { params });

            const accountData = response.result.list[0];
            const balances = accountData.coin || [];
            const usdtBalance = balances.find(b => b.coin === 'USDT');

            const totalMarginBalance = parseFloat(accountData.totalMarginBalance || 0);
            const unrealisedPnl = parseFloat(accountData.totalPerpUPL || usdtBalance?.unrealisedPnl || 0);
            const walletBalance = parseFloat(accountData.totalWalletBalance || 0);
            
            return {
                total: totalMarginBalance,
                unrealisedPnl: unrealisedPnl,
                available: parseFloat(accountData.totalAvailableBalance || 0),
                walletBalance: walletBalance,
            };
        } catch (error) {
            throw new Error(`Failed to get account balance: ${error.message}`);
        }
    }

    /**
     * 获取持仓模式
     * @returns {Promise<Object>} 持仓模式信息
     */
    async getPositionMode() {
        try {
            const response = await this.client.get('/v5/position/switch-mode');
            return response.result;
        } catch (error) {
            throw new Error(`Failed to get position mode: ${error.message}`);
        }
    }

    /**
     * 设置持仓模式
     * @param {number} mode - 持仓模式: 0 (单向持仓) 或 3 (双向持仓)
     * @returns {Promise<Object>} 设置结果
     */
    async setPositionMode(mode = 0) {
        try {
            const response = await this.client.post('/v5/position/switch-mode', {
                category: 'linear',
                mode: mode,
                coin: 'USDT'
            });
            console.log(`Position mode set to: ${mode === 0 ? 'net_mode' : 'long_short_mode'}`);
            return response.result;
        } catch (error) {
            throw new Error(`Failed to set position mode: ${error.message}`);
        }
    }

    /**
     * 设置杠杆
     * @param {string} symbol - 产品ID
     * @param {number} buyLeverage - 买入杠杆
     * @param {number} sellLeverage - 卖出杠杆
     * @returns {Promise<Object>} 设置结果
     */
    async setLeverage(symbol, leverage) {
        try {
            const response = await this.client.post('/v5/position/set-leverage', {
                category: 'linear',
                symbol: symbol,
                buyLeverage: leverage.toString(),
                sellLeverage: leverage.toString()
            });
            return response.result;
        } catch (error) {
            if (error.message.includes('110043')) {
                console.log(`杠杆已是 ${leverage}x，无需修改`);
            } else {
                throw new Error(`Failed to set leverage: ${error.message}`);
            }
        }
    }

    /**
     * 取消所有订单
     * @param {string} symbol - 产品ID
     * @returns {Promise<Object>}
     */
    async cancelAllOrders(symbol) {
        try {
            const response = await this.client.post('/v5/order/cancel-all', {
                category: 'linear',
                symbol: symbol
            });
            return response.result;
        } catch (error) {
            throw new Error(`Failed to cancel all orders: ${error.message}`);
        }
    }

    /**
     * 获取订单信息
     * @param {string} symbol - 产品ID
     * @param {string} [orderId] - 订单ID
     * @returns {Promise<Object>}
     */
    async getOrder(symbol, orderId) {
        try {
            const params = {
                category: 'linear',
                symbol: symbol
            };
            if (orderId) {
                params.orderId = orderId;
            }
            const response = await this.client.get('/v5/order/realtime', { params });
            return response.result.list[0];
        } catch (error) {
            throw new Error(`Failed to get order: ${error.message}`);
        }
    }

    /**
     * 获取tickSize的小数位数
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
}

module.exports = { BybitClient };