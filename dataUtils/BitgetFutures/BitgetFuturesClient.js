const axios = require('axios');
const crypto = require('crypto');
const { isEmpty } = require("lodash");

class BitgetFuturesClient {
    constructor({ apiKey, secretKey, passphrase, isSimulated = false }) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.passphrase = passphrase;
        // Bitget 官方也提供 api.bitget.fit 作为镜像域名
        // 你当前环境对部分域名可能会出现连接重置（ECONNRESET）
        this.baseURLCandidates = ['https://api.bitget.com'];
        this.baseURL = this.baseURLCandidates[0];
        this.isSimulated = isSimulated;

        // 交易/下单 (v2) 使用的 productType
        this.tradeProductType = 'usdt-futures';
        this.marginCoin = 'USDT';
        // 公共行情接口：不带签名/私有 header，避免触发风控或连接重置
        this.publicClient = axios.create({
            baseURL: this.baseURL,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                locale: 'en-US'
            }
        });

        // 私有交易接口：带签名/私有 header
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                locale: 'en-US'
            }
        });

        this.publicClient.interceptors.response.use(
            (response) => {
                const data = response.data;
                if (data && typeof data === 'object' && 'code' in data) {
                    if (data.code !== '00000' && data.code !== 0) {
                        // bitget public 接口一般是 code/msg/data 结构
                        throw new Error(`Bitget API Error: ${data.msg || 'unknown'} (${data.code})`);
                    }
                    return data;
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

        this.client.interceptors.request.use((config) => {
            const method = (config.method || 'GET').toUpperCase();
            const timestamp = Date.now().toString();
            const path = config.url;

            // 构建查询字符串
            const queryString = this._buildQueryString(config.params || {});

            // 构建请求体（对于POST请求）
            const body = config.data ? JSON.stringify(config.data) : '';

            // 生成签名
            const sign = this._generateSign(timestamp, method, path, queryString, body);

            config.headers = {
                ...config.headers,
                'ACCESS-KEY': this.apiKey,
                'ACCESS-SIGN': sign,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': this.passphrase,
                locale: 'en-US'
            };

            if (this.isSimulated) {
                config.headers['paptrading'] = '1';
            }

            return config;
        });

        this.client.interceptors.response.use(
            (response) => {
                const { data } = response;
                if (!data) {
                    throw new Error('Bitget 返回空响应');
                }
                if (data.code !== '00000') {
                    throw new Error(`Bitget API Error: ${data.msg} (${data.code})`);
                }
                return data;
            },
            (error) => {
                if (error.response) {
                    throw new Error(`HTTP Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
                }
                throw error;
            }
        );
    }

    _buildQueryString(params = {}) {
        return Object.keys(params)
            .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
            .sort()
            .map((key) => `${key}=${encodeURIComponent(params[key])}`)
            .join('&');
    }

    _generateSign(timestamp, method, requestPath, queryString = '', body = '') {
        // 确保方法名大写
        method = method.toUpperCase();

        // 处理空值情况
        body = body || '';
        queryString = queryString ? '?' + queryString : '';

        // 构建签名字符串
        const preHash = timestamp + method + requestPath + queryString + body;

        // 生成签名 (与Java版本一致)
        return crypto
            .createHmac('sha256', this.secretKey)
            .update(preHash, 'utf8')  // 明确指定编码
            .digest('base64');
    }

    formatSymbol(symbol) {
        if (symbol.includes('_UMCBL')) return symbol;
        const clean = symbol.replace('-USDT-SWAP', '').replace('_USDT', '').replace('USDT', '');
        return `${clean}USDT_UMCBL`;
    }

    async getContracts() {
        // 合约列表接口在部分网络下可能触发连接重置，做多域名兜底
        const resp = await this._publicGetWithFallback('/api/v2/mix/market/contracts', {
            productType: this.tradeProductType
        });
        const payload = resp?.data ?? resp?.result ?? resp;
        if (Array.isArray(payload)) return payload;
        if (payload && Array.isArray(payload.data)) return payload.data;
        if (payload && Array.isArray(payload.contracts)) return payload.contracts;
        return [];
    }

    async getTicker(symbol) {
        const resp = await this._publicGetWithFallback('/api/v2/mix/market/ticker', {
            symbol: this._toV2Symbol(symbol),
            productType: this.tradeProductType
        });
        if (isEmpty(resp?.data)) {
            return {}
        }
        return resp.data[0];
    }

    _toV2Symbol(symbol) {
        if (!symbol) return symbol;
        if (symbol.includes('_UMCBL')) return symbol.replace('_UMCBL', '');
        if (symbol.includes('USDT')) return symbol;
        // 兼容传入 BTC/ETH 这种“基础币”
        return `${symbol}USDT`;
    }

    async _publicGetWithFallback(path, params) {
        let lastErr;
        for (const baseURL of this.baseURLCandidates) {
            try {
                const resp = await axios.get(`${baseURL}${path}`, {
                    params,
                    timeout: 15000,
                    headers: {
                        'Content-Type': 'application/json',
                        locale: 'zh-CN'
                    }
                });
                return resp.data;
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    }

    async getAccount() {
        let lastError;
        for (const baseURL of this.baseURLCandidates) {
            try {
                // 创建临时客户端
                const tempClient = axios.create({
                    baseURL: baseURL,
                    timeout: 30000,
                    headers: {
                        'Content-Type': 'application/json',
                        locale: 'en-US'
                    }
                });

                // 复制请求拦截器
                tempClient.interceptors.request.use((config) => {
                    const method = (config.method || 'GET').toUpperCase();
                    const timestamp = Date.now().toString();
                    const path = config.url;

                    // 构建查询字符串
                    const queryString = this._buildQueryString(config.params || {});

                    // 构建请求体（对于POST请求）
                    const body = config.data ? JSON.stringify(config.data) : '';

                    // 生成签名
                    const sign = this._generateSign(timestamp, method, path, queryString, body);

                    config.headers = {
                        ...config.headers,
                        'ACCESS-KEY': this.apiKey,
                        'ACCESS-SIGN': sign,
                        'ACCESS-TIMESTAMP': timestamp,
                        'ACCESS-PASSPHRASE': this.passphrase,
                        locale: 'en-US'
                    };

                    if (this.isSimulated) {
                        config.headers['paptrading'] = '1';
                    }

                    return config;
                });

                // 复制响应拦截器
                tempClient.interceptors.response.use(
                    (response) => {
                        const { data } = response;
                        if (!data) {
                            throw new Error('Bitget 返回空响应');
                        }
                        if (data.code !== '00000') {
                            throw new Error(`Bitget API Error: ${data.msg} (${data.code})`);
                        }
                        return data;
                    },
                    (error) => {
                        if (error.response) {
                            throw new Error(`HTTP Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
                        }
                        throw error;
                    }
                );

                const resp = await tempClient.get('/api/v2/mix/account/accounts', {
                    params: { productType: this.tradeProductType }
                });
                const list = resp.data?.data || resp.data || [];
                const account = list.find((item) => (item.marginCoin || '').toUpperCase() === this.marginCoin) || list[0];

                if (account) {
                    return account;
                }
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('所有 API 域名都无法获取账户信息');
    }

    async getPositions(symbol) {
        const params = symbol
            ? { symbol: this._toV2Symbol(symbol), marginCoin: this.marginCoin, productType: this.tradeProductType }
            : { productType: this.tradeProductType };
        const path = symbol ? '/api/v2/mix/position/single-position' : '/api/v2/mix/position/all-position';
        const resp = await this.client.get(path, { params });
        const data = resp.data || [];
        return data;
    }


    async setPositionMode(holdMode = 'one_way_mode') {
        const posMode = holdMode === 'one_way_mode' ? 'one_way_mode' : 'hedge_mode';
        return this.client.post('/api/v2/mix/account/set-position-mode', {
            productType: this.tradeProductType,
            posMode
        });
    }

    async setLeverage(symbol, leverage) {
        return this.client.post('/api/v2/mix/account/set-leverage', {
            symbol: this._toV2Symbol(symbol),
            productType: this.tradeProductType,
            marginCoin: this.marginCoin,
            leverage: `${leverage}`,
            marginMode: "crossed"
        });
    }

    async placeOrder(params) {
        // v2：下单接口
        // - one-way-mode 下 tradeSide 会被忽略
        // - hedge-mode 下 tradeSide 需要显式传 open/close
        const {
            symbol,
            size,
            side, // buy/sell
            orderType = 'market',
            marginMode = 'crossed',
            force = 'ioc',
            reduceOnly = 'NO',
            presetStopSurplusPrice,
            presetStopLossPrice
        } = params;

        return this.client.post('/api/v2/mix/order/place-order', {
            symbol: this._toV2Symbol(symbol),
            productType: this.tradeProductType,
            marginMode,
            marginCoin: this.marginCoin,
            size: `${size}`,
            side,
            orderType,
            force,
            reduceOnly,
            presetStopSurplusPrice: presetStopSurplusPrice !== undefined ? `${presetStopSurplusPrice}` : undefined,
            presetStopLossPrice: presetStopLossPrice !== undefined ? `${presetStopLossPrice}` : undefined
        });
    }

    async closePosition(symbol, holdSide, size) {
        // v2 没有统一的 close-position 接口，这里用 reduceOnly 的市价订单来平仓
        const closeSide = holdSide === 'long' ? 'sell' : 'buy';
        return this.placeOrder({
            symbol,
            size,
            side: closeSide,
            tradeSide: 'close',
            orderType: 'market',
            force: 'ioc',
            reduceOnly: 'YES'
        });
    }

    async placeTPSLPlan(params) {
        return this.client.post('/api/mix/v1/plan/placeTPSL', params);
    }

    // 带单专用 API 方法
    async getTraderOrdersTrack(traderId, pageNo = 1, pageSize = 20, symbol = '') {
        const params = {
            traderId,
            pageNo,
            pageSize
        };
        if (symbol) {
            params.symbol = symbol;
        }
        return this.client.get('/api/copy/v1/trader/orders-track', { params });
    }

    async getTraderInfo(traderId) {
        return this.client.get('/api/copy/v1/trader/info', { params: { traderId } });
    }

    async getTraderPerformance(traderId, period = '7d') {
        return this.client.get('/api/copy/v1/trader/performance', { params: { traderId, period } });
    }

    /**
     * 带单下单方法
     * 使用普通下单接口执行带单交易
     * 
     * @param {Object} params - 参数对象
     * @param {string} params.symbol - 交易对符号 (如: BTCUSDT)
     * @param {string} params.marginCoin - 保证金币种 (USDT)
     * @param {string} params.side - 订单方向 (open_long: 开多, open_short: 开空)
     * @param {string} params.orderType - 订单类型 (market: 市价单)
     * @param {string} params.size - 订单数量
     * @param {string} params.leverage - 杠杆倍数
     * @param {string} params.tpTriggerPrice - 止盈触发价格
     * @param {string} params.slTriggerPrice - 止损触发价格
     * @param {string} params.tpOrderPrice - 止盈委托价格
     * @param {string} params.slOrderPrice - 止损委托价格
     * @returns {Promise<Object>} 下单结果
     */
    async placeLeaderOrder(params) {
        const {
            symbol,
            marginCoin = 'USDT',
            side, // open_long, open_short, close_long, close_short
            orderType = 'market',
            size,
            leverage,
            tpTriggerPrice,
            slTriggerPrice,
            tpOrderPrice,
            slOrderPrice
        } = params;

        // 先平仓当前币种的仓位
        try {
            // 获取当前仓位信息
            const positions = await this.client.get('/api/v3/position/current-position', {
                params: {
                    category: 'USDT-FUTURES',
                    symbol: this._toV2Symbol(symbol)
                }
            });
            // 如果有仓位，使用市价单平仓
            if (positions && positions.data && positions.data.list.length > 0) {
                for (const pos of positions.data.list) {
                    console.log(34, pos)

                    if (parseFloat(pos.total) > 0) {
                        const res = await this.client.post('/api/v3/trade/close-positions', {
                            category: 'USDT-FUTURES',
                            symbol: this._toV2Symbol(symbol),
                            posSide: pos.posSide
                        });
                    }
                }
            }
        } catch (error) {
            // 平仓失败不影响继续下单
            console.log('平仓失败或无仓位:', error.message);
        }

        // 使用v3版本的普通下单接口
        // 注意: 带单交易只是使用普通下单接口，不需要特殊的带单API
        // v3 API需要使用USDT格式的symbol，不需要_UMCBL后缀

        const requestData = {
            category: 'USDT-FUTURES',
            symbol: this._toV2Symbol(symbol),
            marginCoin,
            qty: `${size}`,
            side: side === 'open_long' ? 'buy' : 'sell',
            orderType,
            posSide: side === 'open_long' ? 'long' : 'short',
            reduceOnly: 'no',
            timeInForce: 'ioc'
        };

        // 添加止盈止损参数（如果存在）
        if (tpTriggerPrice) {
            requestData.takeProfit = `${tpTriggerPrice}`;
            requestData.tpTriggerBy = 'market';
        }
        if (slTriggerPrice) {
            requestData.stopLoss = `${slTriggerPrice}`;
            requestData.slTriggerBy = 'market';
        }
        if (tpOrderPrice) {
            requestData.tpOrderType = 'limit';
            requestData.tpLimitPrice = `${tpOrderPrice}`;
        }
        if (slOrderPrice) {
            requestData.slOrderType = 'limit';
            requestData.slLimitPrice = `${slOrderPrice}`;
        }

        console.log('下单参数:', requestData);
        const orderResult = await this.client.post('/api/v3/trade/place-order', requestData);

        // // 设置杠杆
        // try {
        //     const res2 = await this.client.post('/api/v3/account/set-leverage', {
        //         category: 'USDT-FUTURES',
        //         leverage: `${leverage}`
        //     });
        //     console.log(6666666, res2)
        // } catch (error) {
        //     console.log('设置杠杆失败:', error.message);
        // }

        return orderResult;
    }
}

module.exports = BitgetFuturesClient;
