import {decrypt} from "./utils";
import {saveUserBalance} from "./saveUserBalance";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {isEmpty} from "lodash";
import {getUserPositions} from "./apiTrade";

// Gate API
const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL;
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL;
let gateClient = new GateApi.ApiClient();

// Binance API
const BinanceFuturesTrade = require('./BinanceFutures/BinanceFuturesTrade');

// OKX API
const OKXFuturesTrade = require('./OKXFutures/OKXFuturesTrade');

// Bitget API
const BitgetFuturesTrade = require('./BitgetFutures/BitgetFuturesTrade');

// Bitget Leader API
const BitgetLeaderTrade = require('./BitgetFutures/BitgetLeaderTrade');

// Bybit API
const BybitFuturesTrade = require('./BybitFutures/BybitFuturesTrade');

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

/**
 * 为指定用户执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据（可选，不提供时自动获取所有持仓）
 * @param {Object} params.userOptions - 用户交易配置
 * @returns {Promise<void>}
 */
export const executeClosePositions = async ({tradeData, userOptions}) => {
    try {
        const {belong} = userOptions;
        
        switch (belong) {
            case 'Gate':
                await executeGateClosePositions({tradeData, userOptions});
                break;
            case 'Binance':
                await executeBinanceClosePositions({tradeData, userOptions});
                break;
            case 'OKX':
                await executeOKXClosePositions({tradeData, userOptions});
                break;
            case 'Bitget':
                await executeBitgetClosePositions({tradeData, userOptions});
                break;
            case 'Bitget_Leader':
                await executeBitgetLeaderClosePositions({tradeData, userOptions});
                break;
            case 'Bybit':
                await executeBybitClosePositions({tradeData, userOptions});
                break;
            default:
                console.log(`不支持的交易所类型: ${belong}`);
                break;
        }
    } catch (error) {
        console.error('执行平仓操作失败:', error.message);
        throw error;
    }
};

/**
 * 为Gate交易所执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据（可选，不提供时自动获取所有持仓）
 * @param {Object} params.userOptions - 用户交易配置
 * @returns {Promise<void>}
 */
export const executeGateClosePositions = async ({tradeData, userOptions}) => {
    try {
        console.log(`为用户 ${userOptions.userId} 在Gate交易所执行平仓操作`);
        
        // 初始化 API 客户端
        const {apiKey, apiSecret, isTestOption} = userOptions;
        gateClient.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
        gateClient.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL;
        
        // 初始化期货 API 接口
        const futuresApi = new GateApi.FuturesApi(gateClient);
        const settle = "usdt";
        
        // 获取账户余额
        const futureAccount = await retryRequest(() => futuresApi.listFuturesAccounts(settle));
        await saveUserBalance(userOptions.userId, futureAccount.body);
        
        let symbolsToClose = [];
        
        if (tradeData && tradeData.length > 0) {
            // 使用提供的交易数据
            symbolsToClose = tradeData.map(item => item.symbol);
        } else {
            // 使用 getUserPositions 获取所有持仓
            console.log(`自动获取Gate交易所的所有持仓`);
            const userPositions = await getUserPositions(userOptions);
            if (userPositions && userPositions.length > 0) {
                symbolsToClose = userPositions.map(position => position.symbol);
            }
            console.log(`找到 ${symbolsToClose.length} 个持仓`);
        }
        
        // 遍历处理每个交易对
        for (const symbol of symbolsToClose) {
            try {
                console.log(`执行平仓操作: ${symbol}`);
                
                // 获取当前持仓
                let position = null;
                try {
                    position = await retryRequest(() => futuresApi.getPosition(settle, `${symbol}_USDT`));
                } catch (e) {
                    console.log(`没有 ${symbol} 的仓位`, e);
                    continue;
                }
                
                // 如果有持仓，执行平仓操作
                if (position && position.body.size !== 0) {
                    console.log(`执行平仓操作: ${symbol}, 持仓大小: ${position.body.size}`);
                    
                    // 调整杠杆（确保平仓时杠杆正确）
                    await retryRequest(() => futuresApi.updatePositionLeverage(settle, `${symbol}_USDT`, position.body.leverage, {}));
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // 下市价平仓单
                    const closeOrder = await retryRequest(() => futuresApi.createFuturesOrder(settle, {
                        contract: `${symbol}_USDT`,
                        size: position.body.size < 0 ? Math.abs(position.body.size) : -position.body.size,
                        price: 0,
                        tif: "ioc",
                    }, {}));
                    await new Promise(resolve => setTimeout(resolve, 300));
                    console.log(`平仓操作完成: ${symbol}`, closeOrder.body);
                
                }
            } catch (e) {
                console.error(`执行 ${symbol} 平仓操作失败:`, e.message);
                // 继续处理下一个交易对
                continue;
            }
        }
        
        console.log(`为用户 ${userOptions.userId} 在Gate交易所的平仓操作执行完成`);
    } catch (error) {
        console.error(`为用户 ${userOptions.userId} 在Gate交易所执行平仓操作失败:`, error.message);
        throw error;
    }
};

/**
 * 为Binance交易所执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据（可选，不提供时自动获取所有持仓）
 * @param {Object} params.userOptions - 用户交易配置
 * @returns {Promise<void>}
 */
export const executeBinanceClosePositions = async ({tradeData, userOptions}) => {
    try {
        console.log(`为用户 ${userOptions.userId} 在Binance交易所执行平仓操作`);
        
        // 初始化 Binance 客户端
        const {apiKey, apiSecret, isTestOption} = userOptions;
        const trader = new BinanceFuturesTrade(decrypt(apiKey), decrypt(apiSecret), isTestOption);
        
        // 获取账户信息
        const accountInfo = await retryRequest(() => trader.checkUserAccount());
        const accountFunds = {
            total: accountInfo.totalWalletBalance,
            unrealisedPnl: accountInfo.totalUnrealizedProfit,
            available: accountInfo.availableBalance
        };
        await saveUserBalance(userOptions.userId, accountFunds);
        
        let symbolsToClose = [];
        
        if (tradeData && tradeData.length > 0) {
            // 使用提供的交易数据
            symbolsToClose = tradeData.map(item => item.symbol);
        } else {
            // 使用 getUserPositions 获取所有持仓
            console.log(`自动获取Binance交易所的所有持仓`);
            const userPositions = await getUserPositions(userOptions);
            if (userPositions && userPositions.length > 0) {
                symbolsToClose = userPositions.map(position => position.symbol);
            }
            console.log(`找到 ${symbolsToClose.length} 个持仓`);
        }
        
        // 遍历处理每个交易对
        for (const symbol of symbolsToClose) {
            try {
                console.log(`执行平仓操作: ${symbol}`);
                
                // 执行平仓操作
                const result = await retryRequest(() => trader.closePosition(`${symbol}USDT`));
                console.log(`平仓结果: ${symbol}`, result);
                
             
            } catch (e) {
                console.error(`执行 ${symbol} 平仓操作失败:`, e.message);
                // 继续处理下一个交易对
                continue;
            }
        }
        
        console.log(`为用户 ${userOptions.userId} 在Binance交易所的平仓操作执行完成`);
    } catch (error) {
        console.error(`为用户 ${userOptions.userId} 在Binance交易所执行平仓操作失败:`, error.message);
        throw error;
    }
};

/**
 * 为OKX交易所执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据（可选，不提供时自动获取所有持仓）
 * @param {Object} params.userOptions - 用户交易配置
 * @returns {Promise<void>}
 */
export const executeOKXClosePositions = async ({tradeData, userOptions}) => {
    try {
        console.log(`为用户 ${userOptions.userId} 在OKX交易所执行平仓操作`);
        
        // 初始化 OKX 客户端
        const {apiKey, apiSecret, passphrase, isTestOption} = userOptions;
        const trader = new OKXFuturesTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase: passphrase,
            isSimulated: isTestOption
        });
        
        // 获取账户信息
        const accountInfo = await retryRequest(() => trader.getAccountInfo());
        const accountFunds = {
            total: accountInfo.balance.total,
            unrealisedPnl: accountInfo.balance.unrealisedPnl,
            available: accountInfo.balance.available
        };
        await saveUserBalance(userOptions.userId, accountFunds);
        
        let symbolsToClose = [];
        
        if (tradeData && tradeData.length > 0) {
            // 使用提供的交易数据
            symbolsToClose = tradeData.map(item => item.symbol);
        } else {
            // 使用 getUserPositions 获取所有持仓
            console.log(`自动获取OKX交易所的所有持仓`);
            const userPositions = await getUserPositions(userOptions);
            if (userPositions && userPositions.length > 0) {
                symbolsToClose = userPositions.map(position => position.symbol);
            }
            console.log(`找到 ${symbolsToClose.length} 个持仓`);
        }
        
        // 遍历处理每个交易对
        for (const symbol of symbolsToClose) {
            try {
                console.log(`执行平仓操作: ${symbol}`);
                
                // 执行平仓操作
                const result = await retryRequest(() => trader.closePosition(`${symbol}-USDT-SWAP`));
                console.log(`平仓结果: ${symbol}`, result);
                
             
            } catch (e) {
                console.error(`执行 ${symbol} 平仓操作失败:`, e.message);
                // 继续处理下一个交易对
                continue;
            }
        }
        
        console.log(`为用户 ${userOptions.userId} 在OKX交易所的平仓操作执行完成`);
    } catch (error) {
        console.error(`为用户 ${userOptions.userId} 在OKX交易所执行平仓操作失败:`, error.message);
        throw error;
    }
};

/**
 * 为Bitget交易所执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据（可选，不提供时自动获取所有持仓）
 * @param {Object} params.userOptions - 用户交易配置
 * @returns {Promise<void>}
 */
export const executeBitgetClosePositions = async ({tradeData, userOptions}) => {
    try {
        console.log(`为用户 ${userOptions.userId} 在Bitget交易所执行平仓操作`);
        
        // 初始化 Bitget 客户端
        const {apiKey, apiSecret, passphrase, isTestOption} = userOptions;
        const trader = new BitgetFuturesTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase: passphrase,
            isSimulated: isTestOption
        });
        
        // 获取账户信息
        const accountInfo = await retryRequest(() => trader.getAccountInfo());
        const accountFunds = {
            total: accountInfo.balance.total,
            unrealisedPnl: accountInfo.balance.unrealisedPnl,
            available: accountInfo.balance.available
        };
        await saveUserBalance(userOptions.userId, accountFunds);
        
        let symbolsToClose = [];
        
        if (tradeData && tradeData.length > 0) {
            // 使用提供的交易数据
            symbolsToClose = tradeData.map(item => item.symbol);
        } else {
            // 使用 getUserPositions 获取所有持仓
            console.log(`自动获取Bitget交易所的所有持仓`);
            const userPositions = await getUserPositions(userOptions);
            if (userPositions && userPositions.length > 0) {
                symbolsToClose = userPositions.map(position => position.symbol);
            }
            console.log(`找到 ${symbolsToClose.length} 个持仓`);
        }
        
        // 遍历处理每个交易对
        for (const symbol of symbolsToClose) {
            try {
                console.log(`执行平仓操作: ${symbol}`);
                
                // 获取当前持仓
                const position = await retryRequest(() => trader.getCurrentPosition(symbol));
                
                // 如果有持仓，执行平仓操作
                if (position && position.total !== 0) {
                    console.log(`执行平仓操作: ${symbol}, 持仓大小: ${position.total}, 方向: ${position.holdSide}`);
                    
                    // 执行平仓操作
                    const result = await retryRequest(() => trader.client.closePosition(symbol, position.holdSide, position.total));
                    console.log(`平仓结果: ${symbol}`, result);
                    
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            } catch (e) {
                console.error(`执行 ${symbol} 平仓操作失败:`, e.message);
                // 继续处理下一个交易对
                continue;
            }
        }
        
        console.log(`为用户 ${userOptions.userId} 在Bitget交易所的平仓操作执行完成`);
    } catch (error) {
        console.error(`为用户 ${userOptions.userId} 在Bitget交易所执行平仓操作失败:`, error.message);
        throw error;
    }
};

/**
 * 为Bitget带单交易所执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据（可选，不提供时自动获取所有持仓）
 * @param {Object} params.userOptions - 用户交易配置
 * @returns {Promise<void>}
 */
export const executeBitgetLeaderClosePositions = async ({tradeData, userOptions}) => {
    try {
        console.log(`为用户 ${userOptions.userId} 在Bitget带单交易所执行平仓操作`);

        // 初始化 Bitget 带单客户端（使用 BitgetFuturesTrade 而不是 BitgetLeaderTrade）
        const {apiKey, apiSecret, passphrase, isTestOption} = userOptions;
        const trader = new BitgetFuturesTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase,
            isSimulated: isTestOption
        });

        // 获取账户信息
        const accountInfo = await retryRequest(() => trader.getAccountInfo());
        const accountFunds = {
            total: accountInfo.balance?.total || '0',
            unrealisedPnl: accountInfo.balance?.unrealisedPnl || '0',
            available: accountInfo.balance?.available || '0'
        };
        await saveUserBalance(userOptions.userId, accountFunds);

        let symbolsToClose = [];

        if (tradeData && tradeData.length > 0) {
            // 使用提供的交易数据
            symbolsToClose = tradeData.map(item => item.symbol);
        } else {
            // 使用 getUserPositions 获取所有持仓
            console.log(`自动获取Bitget带单交易所的所有持仓`);
            const userPositions = await getUserPositions(userOptions);
            if (userPositions && userPositions.length > 0) {
                symbolsToClose = userPositions.map(position => position.symbol);
            }
            console.log(`找到 ${symbolsToClose.length} 个持仓`);
        }

        // 遍历处理每个交易对
        for (const symbol of symbolsToClose) {
            try {
                console.log(`执行平仓操作: ${symbol}`);

                // 获取当前持仓
                const position = await retryRequest(() => trader.getCurrentPosition(symbol));

                // 如果有持仓，执行平仓操作
                if (position && position.total !== 0) {
                    console.log(`执行平仓操作: ${symbol}, 持仓大小: ${position.total}, 方向: ${position.holdSide}`);

                    // 执行平仓操作
                    const result = await retryRequest(() => trader.client.closePosition(symbol, position.holdSide, position.total));
                    console.log(`平仓结果: ${symbol}`, result);

                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            } catch (e) {
                console.error(`执行 ${symbol} 平仓操作失败:`, e.message);
                // 继续处理下一个交易对
                continue;
            }
        }

        console.log(`为用户 ${userOptions.userId} 在Bitget带单交易所的平仓操作执行完成`);
    } catch (error) {
        console.error(`为用户 ${userOptions.userId} 在Bitget带单交易所执行平仓操作失败:`, error.message);
        throw error;
    }
};

/**
 * 为Bybit交易所执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据（可选，不提供时自动获取所有持仓）
 * @param {Object} params.userOptions - 用户交易配置
 * @returns {Promise<void>}
 */
export const executeBybitClosePositions = async ({tradeData, userOptions}) => {
    try {
        console.log(`为用户 ${userOptions.userId} 在Bybit交易所执行平仓操作`);

        // 初始化 Bybit 客户端
        const {apiKey, apiSecret, isTestOption} = userOptions;
        const trader = new BybitFuturesTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            isTestnet: isTestOption
        });

        // 获取账户信息
        const accountInfo = await retryRequest(() => trader.getAccountInfo());
        const accountFunds = {
            total: accountInfo.balance?.total?.toString() || '0',
            unrealisedPnl: accountInfo.balance?.unrealisedPnl?.toString() || '0',
            available: accountInfo.balance?.available?.toString() || '0'
        };
        await saveUserBalance(userOptions.userId, accountFunds);

        let symbolsToClose = [];

        if (tradeData && tradeData.length > 0) {
            // 使用提供的交易数据
            symbolsToClose = tradeData.map(item => item.symbol);
        } else {
            // 使用 getUserPositions 获取所有持仓
            console.log(`自动获取Bybit交易所的所有持仓`);
            const userPositions = await getUserPositions(userOptions);
            if (userPositions && userPositions.length > 0) {
                symbolsToClose = userPositions.map(position => position.symbol);
            }
            console.log(`找到 ${symbolsToClose.length} 个持仓`);
        }

        // 遍历处理每个交易对
        for (const symbol of symbolsToClose) {
            try {
                console.log(`执行平仓操作: ${symbol}`);

                // 执行平仓操作
                const result = await retryRequest(() => trader.closePosition(`${symbol}USDT`));
                console.log(`平仓结果: ${symbol}`, result);

                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (e) {
                console.error(`执行 ${symbol} 平仓操作失败:`, e.message);
                // 继续处理下一个交易对
                continue;
            }
        }

        console.log(`为用户 ${userOptions.userId} 在Bybit交易所的平仓操作执行完成`);
    } catch (error) {
        console.error(`为用户 ${userOptions.userId} 在Bybit交易所执行平仓操作失败:`, error.message);
        throw error;
    }
};