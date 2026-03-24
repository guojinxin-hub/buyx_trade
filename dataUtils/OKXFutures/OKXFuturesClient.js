const axios = require('axios');
const crypto = require('crypto');

class OKXClient {
    /**
     * 初始化OKX客户端
     * @param {Object} config - 配置对象
     * @param {string} config.apiKey - API Key
     * @param {string} config.secretKey - Secret Key
     * @param {string} config.passphrase - Passphrase
     * @param {string} config.baseURL - API基础URL (默认: https://www.okx.com)
     * @param {boolean} config.isSimulated - 是否模拟盘 (默认: false)
     */
    constructor(config) {
        this.apiKey = config.apiKey;
        this.secretKey = config.secretKey;
        this.passphrase = config.passphrase;
        this.baseURL = config.baseURL || 'https://www.okx.com';
        this.isSimulated = config.isSimulated || false;
        // 创建axios实例
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        // 修改请求拦截器
        this.client.interceptors.request.use((config) => {
            if (this.apiKey && this.secretKey && this.passphrase) {
                const timestamp = new Date().toISOString();
                const method = config.method.toUpperCase();

                // 构建完整路径（包括查询参数）
                let path = config.url;
                if (config.params && Object.keys(config.params).length > 0) {
                    const queryString = new URLSearchParams(config.params).toString();
                    path = `${path}?${queryString}`;
                }

                const body = config.data ? JSON.stringify(config.data) : '';
                const sign = this._generateSign(timestamp, method, path, body);

                config.headers = {
                    ...config.headers,
                    'OK-ACCESS-KEY': this.apiKey,
                    'OK-ACCESS-SIGN': sign,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': this.passphrase,
                };

                if (this.isSimulated) {
                    config.headers['x-simulated-trading'] = '1';
                }
            }
            return config;
        });

        // 响应拦截器
        this.client.interceptors.response.use(
            (response) => {
                if (response.data.code !== '0') {
                    throw new Error(`API Error: ${response.data.msg} (${response.data.code})`);
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
     * 生成签名
     * @private
     */
    _generateSign(timestamp, method, path, body) {
        const message = timestamp + method + path + body;
        const hmac = crypto.createHmac('sha256', this.secretKey);
        return hmac.update(message).digest('base64');
    }

    /**
     * 获取交易产品信息
     * @param {string} instId - 产品ID (如: ETH-USDT-SWAP)
     * @returns {Promise<Object>} 产品信息
     */
    async getInstrumentInfo(instId) {
        // 检查缓存
        if (this.instrumentCache.has(instId)) {
            return this.instrumentCache.get(instId);
        }

        try {
            const response = await this.client.get('/api/v5/public/instruments', {
                params: {
                    instType: 'SWAP',
                    instId: instId
                }
            });

            if (response.data && response.data.length > 0) {
                const instrument = response.data[0];
                this.instrumentCache.set(instId, instrument);
                return instrument;
            }
            throw new Error(`Instrument not found: ${instId}`);
        } catch (error) {
            throw new Error(`Failed to get instrument info: ${error.message}`);
        }
    }

    /**
     * 获取币种信息
     * @param {string} ccy - 币种 (如: USDT)
     * @returns {Promise<Object>} 币种信息
     */
    async getCurrencyInfo() {
        try {
            const config = {
                params: {
                    instType: "SWAP"
                }
            }
            const response = await this.client.get('/api/v5/public/instruments', config);

            if (response.data && response.data.length > 0) {
                return response.data;
            }
        } catch (error) {
            throw new Error(`Failed to get currency info: ${error.message}`);
        }
    }

    /**
     * 获取行情信息
     * @param {string} instId - 产品ID
     * @returns {Promise<Object>} 行情数据
     */
    async getTicker(instId) {
        try {
            const response = await this.client.get('/api/v5/market/ticker', {
                params: {instId}
            });
            return response.data[0];
        } catch (error) {
            throw new Error(`Failed to get ticker: ${error.message}`);
        }
    }

    /**
     * 下单
     * @param {Object} params - 下单参数
     * @param {string} params.instId - 产品ID
     * @param {string} params.side - 买卖方向 (buy/sell)
     * @param {string} params.ordType - 订单类型 (market/limit)
     * @param {number} params.sz - 数量(张数)
     * @param {string} params.tdMode - 交易模式 (cross/isolated)
     * @param {number} [params.px] - 价格(限价单必填)
     * @param {boolean} [params.reduceOnly] - 是否只减仓
     * @param {string} [params.posSide] - 持仓方向 (net/long/short)
     * @param {Object} [params.attachAlgoOrds] - 附加止盈止损
     * @returns {Promise<Object>} 订单结果
     */
    async placeOrder(params) {
        try {
            // 验证并处理价格精度
            if (params.px) {
                const instrument = await this.getInstrumentInfo(params.instId);
                const tickSz = parseFloat(instrument.tickSz);
                const decimals = Math.abs(Math.log10(tickSz));
                params.px = parseFloat(params.px.toFixed(decimals));
            }

            console.log("params.attachAlgoOrds1",params.attachAlgoOrds)
            // 处理止盈止损价格精度
            if (params.attachAlgoOrds) {
                const instrument = await this.getInstrumentInfo(params.instId);
                const tickSz = parseFloat(instrument.tickSz);
                const decimals = Math.abs(Math.log10(tickSz));

                if (params.attachAlgoOrds.tpTriggerPx) {
                    params.attachAlgoOrds.tpTriggerPx = parseFloat(
                        params.attachAlgoOrds.tpTriggerPx.toFixed(decimals)
                    );
                }
                if (params.attachAlgoOrds.slTriggerPx) {
                    params.attachAlgoOrds.slTriggerPx = parseFloat(
                        params.attachAlgoOrds.slTriggerPx.toFixed(decimals)
                    );
                }
            }
console.log("params.attachAlgoOrds2",params.attachAlgoOrds)
            const orderData = {
                isTradeBorrowMode: false,
                instId: params.instId,
                tdMode: params.tdMode || 'cross',
                side: params.side,
                posSide: params.posSide || 'net',
                ordType: params.ordType,
                sz: params.sz,
                reduceOnly: params.reduceOnly || false
            };

            if (params.px) {
                orderData.px = params.px.toString();
            }

            if (params.attachAlgoOrds) {
                orderData.attachAlgoOrds = [params.attachAlgoOrds];
            }
            console.log("orderData", orderData)
            const response = await this.client.post('/api/v5/trade/order', orderData);
            console.log("response", response)
            return response.data[0];
        } catch (error) {
            throw new Error(`Failed to place order: ${error.message}`);
        }
    }

    /**
     * 使用USDT金额下单
     * @param {Object} params - 下单参数
     * @param {string} params.instId - 产品ID
     * @param {string} params.side - 买卖方向
     * @param {number} params.size - 张
     * @param {string} params.ordType - 订单类型
     * @param {Object} [params.attachAlgoOrds] - 附加止盈止损
     * @returns {Promise<Object>} 订单结果
     */
    async placeOrderWithUsdt(params) {
        return this.placeOrder({
            instId: params.instId,
            side: params.side,
            sz: params.size,
            ordType: params.ordType || 'market',
            tdMode: 'cross',
            attachAlgoOrds: params.attachAlgoOrds
        });
    }

    async closePosition(position) {
        try {
            // 判断平仓方向
            const pos = parseFloat(position.pos);
            const side = pos > 0 ? 'sell' : 'buy';

            // 市价平仓
            return this.placeOrder({
                instId: position.instId,
                side: side,
                sz: Math.abs(pos),
                ordType: 'market',
                tdMode: 'cross',
                posSide: position.posSide,
                reduceOnly: true
            });
        } catch (error) {
            throw new Error(`Failed to close position: ${error.message}`);
        }
    }

    /**
     * 获取持仓信息
     * @param {string} [instId] - 产品ID，不传则获取所有持仓
     * @returns {Promise<Array>} 持仓列表
     */
    async getPositions(instId) {
        try {
            const params = {};
            if (instId) {
                params.instId = instId;
            }
            const response = await this.client.get('/api/v5/account/positions', {params});
            return response.data || [];
        } catch (error) {
            throw new Error(`Failed to get positions: ${error.message}`);
        }
    }

    /**
     * 获取账户余额
     * @param {string} [ccy] - 币种，不传则获取所有币种余额
     * @returns {Promise<Object>} 账户余额
     */
    async getAccountBalance(ccy) {
        try {
            const params = {};
            if (ccy) {
                params.ccy = ccy;
            }

            const response = await this.client.get('/api/v5/account/balance', {params});
            const details = response.data[0]?.details || [];

            const usdtAvailBal = details.find((o) => o.ccy === "USDT")
            // 格式化返回数据
            const balance = {
                total: usdtAvailBal.cashBal,
                unrealisedPnl: usdtAvailBal.upl,
                available: usdtAvailBal.availBal
            };

            return balance;
        } catch (error) {
            throw new Error(`Failed to get account balance: ${error.message}`);
        }
    }

    /**
     * 获取当前持仓模式
     * @returns {Promise<Object>} 持仓模式信息
     */
    async getPositionMode() {
        try {
            const response = await this.client.get('/api/v5/account/config');
            return response.data[0];
        } catch (error) {
            throw new Error(`Failed to get position mode: ${error.message}`);
        }
    }

    /**
     * 设置持仓模式
     * @param {string} mode - 持仓模式: 'net' (单向持仓) 或 'long_short_mode' (双向持仓)
     * @returns {Promise<Object>} 设置结果
     *
     * @description
     * 设置持仓模式前需满足以下条件[citation:1]：
     * 1. 没有持仓
     * 2. 没有挂单
     */
    async setPositionMode(mode = 'net_mode') {
        try {
            // 验证参数
            if (!['net_mode', 'long_short_mode'].includes(mode)) {
                throw new Error(`Invalid position mode: ${mode}. Must be 'net_mode' or 'long_short_mode'`);
            }

            const response = await this.client.post('/api/v5/account/set-position-mode', {
                posMode: mode
            });

            console.log(`Position mode set to: ${mode}`);
            return response.data[0];
        } catch (error) {
            throw new Error(`Failed to set position mode: ${error.message}`);
        }
    }

    /**
     * 调整杠杆倍数
     * @param {string} instId - 产品ID
     * @param {number} lever - 杠杆倍数
     * @param {string} [mgnMode] - 保证金模式 (cross/isolated)
     * @param {string} [posSide] - 持仓方向
     * @returns {Promise<Object>} 设置结果
     */
    async setLeverage(instId, lever, mgnMode = 'cross', posSide = 'net') {
        try {
            const response = await this.client.post('/api/v5/account/set-leverage', {
                instId: instId,
                lever: lever.toString(),
                mgnMode: mgnMode,
                posSide: posSide
            });
            return response.data[0];
        } catch (error) {
            throw new Error(`Failed to set leverage: ${error.message}`);
        }
    }
}

// 导出
module.exports = {OKXClient};