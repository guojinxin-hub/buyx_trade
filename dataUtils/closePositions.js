import {decrypt} from "./utils";
import {saveUserBalance} from "./saveUserBalance";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {isEmpty} from "lodash";

// Gate API
const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL;
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL;
let gateClient = new GateApi.ApiClient();

// Binance API
const BinanceFuturesTrade = require('./BinanceFutures/BinanceFuturesTrade');

/**
 * 为指定用户执行平仓操作
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据
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
 * @param {Array} params.tradeData - 交易数据
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
        const futureAccount = await futuresApi.listFuturesAccounts(settle);
        await saveUserBalance(userOptions.userId, futureAccount.body);
        
        // 遍历处理每个交易信号
        for (const item of tradeData) {
            try {
                const {symbol} = item;
                console.log(`执行平仓操作: ${symbol}`);
                
                // 获取当前持仓
                let position = null;
                try {
                    position = await futuresApi.getPosition(settle, `${symbol}_USDT`);
                } catch (e) {
                    console.log(`没有 ${symbol} 的仓位`, e);
                    continue;
                }
                
                // 如果有持仓，执行平仓操作
                if (position && position.body.size !== 0) {
                    console.log(`执行平仓操作: ${symbol}, 持仓大小: ${position.body.size}`);
                    
                    // 调整杠杆（确保平仓时杠杆正确）
                    await futuresApi.updatePositionLeverage(settle, `${symbol}_USDT`, position.body.leverage, {});
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // 下市价平仓单
                    const closeOrder = await futuresApi.createFuturesOrder(settle, {
                        contract: `${symbol}_USDT`,
                        size: position.body.size < 0 ? Math.abs(position.body.size) : -position.body.size,
                        price: 0,
                        tif: "ioc",
                    }, {});
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    console.log(`平仓操作完成: ${symbol}`, closeOrder.body);
                    
                    // 更新交易记录状态为已平仓
                    try {
                        await TradeRecordModel.updateMany(
                            {
                                userId: userOptions.userId,
                                symbol: symbol,
                                status: { $ne: 'closed' }
                            },
                            {
                                $set: {
                                    status: 'closed',
                                    closeTime: new Date(),
                                    closePrice: closeOrder.body.fillPrice || null
                                }
                            }
                        );
                        console.log(`已更新 ${symbol} 的交易记录状态为已平仓`);
                    } catch (e) {
                        console.error(`更新交易记录状态失败:`, e.message);
                        // 继续执行，不因记录更新失败而中断流程
                    }
                }
            } catch (e) {
                console.error(`执行 ${item.symbol} 平仓操作失败:`, e.message);
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
 * @param {Array} params.tradeData - 交易数据
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
        const accountInfo = await trader.checkUserAccount();
        const accountFunds = {
            total: accountInfo.totalWalletBalance,
            unrealisedPnl: accountInfo.totalUnrealizedProfit,
            available: accountInfo.availableBalance
        };
        await saveUserBalance(userOptions.userId, accountFunds);
        
        // 遍历处理每个交易信号
        for (const item of tradeData) {
            try {
                const {symbol} = item;
                console.log(`执行平仓操作: ${symbol}`);
                
                // 执行平仓操作
                const result = await trader.closePosition(`${symbol}USDT`);
                console.log(`平仓结果: ${symbol}`, result);
                
                // 更新交易记录状态为已平仓
                try {
                    await TradeRecordModel.updateMany(
                        {
                            userId: userOptions.userId,
                            symbol: symbol,
                            status: { $ne: 'closed' }
                        },
                        {
                            $set: {
                                status: 'closed',
                                closeTime: new Date(),
                                closePrice: result.filledPrice || null
                            }
                        }
                    );
                    console.log(`已更新 ${symbol} 的交易记录状态为已平仓`);
                } catch (e) {
                    console.error(`更新交易记录状态失败:`, e.message);
                    // 继续执行，不因记录更新失败而中断流程
                }
            } catch (e) {
                console.error(`执行 ${item.symbol} 平仓操作失败:`, e.message);
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
