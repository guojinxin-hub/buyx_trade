const axios = require('axios');
const crypto = require('crypto');
const {isEmpty} = require("lodash");

class BitgetFuturesClient {
    constructor({apiKey, secretKey, passphrase, isSimulated = false}) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.passphrase = passphrase;
        // Bitget 官方也提供 api.bitget.fit 作为镜像域名
        // 你当前环境对部分域名可能会出现连接重置（ECONNRESET）
        this.baseURLCandidates = ['https://api.bitget.com', 'https://api.bitget.fit'];
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
                const {data} = response;
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
        console.log(this.apiKey,
            this.secretKey,
            this.passphrase)
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

        console.log('Pre-hash string:', preHash); // 调试用

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
        console.log("resp?.data", resp?.data)
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
                console.log(`尝试使用域名 ${baseURL} 获取账户信息`);
                
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
                        const {data} = response;
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
                    params: {productType: this.tradeProductType}
                });
                const list = resp.data?.data || resp.data || [];
                const account = list.find((item) => (item.marginCoin || '').toUpperCase() === this.marginCoin) || list[0];
                
                if (account) {
                    console.log(`成功使用域名 ${baseURL} 获取账户信息`);
                    return account;
                }
            } catch (error) {
                lastError = error;
                console.warn(`使用域名 ${baseURL} 获取账户信息失败:`, error.message);
            }
        }
        throw lastError || new Error('所有 API 域名都无法获取账户信息');
    }

    async getPositions(symbol) {
        const params = symbol
            ? {symbol: this._toV2Symbol(symbol), marginCoin: this.marginCoin, productType: this.tradeProductType}
            : {productType: this.tradeProductType};
        const path = symbol ? '/api/v2/mix/position/single-position' : '/api/v2/mix/position/all-position';
        const resp = await this.client.get(path, {params});
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
}

module.exports = BitgetFuturesClient;
