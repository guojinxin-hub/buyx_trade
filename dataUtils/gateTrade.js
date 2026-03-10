import {intersectionWith, isEmpty} from "lodash";
import {formatPrice} from "./formatPrice";
import {decrypt} from "./utils";
import {saveTradeRecord} from "./saveTradeRecord";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {saveUserBalance} from "./saveUserBalance";

const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL
let client = new GateApi.ApiClient();

// 更新保护止损单
export const updateProtectionStopLoss = async (req, res) => {
    try {
        const { userOptions, symbol, direction, protectionPrice } = req.body;
        
        // 1. 初始化 API 客户端
        const {apiKey, apiSecret, isTestOption} = userOptions
        client.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
        client.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL
        
        // 2. 初始化期货 API 接口
        const futuresApi = new GateApi.FuturesApi(client);
        const settle = "usdt" // 结算货币为 USDT 本位合约
        
        // 3. 获取合约详细信息
        let futureContract;
        let findFutureContract;
        try {
            futureContract = await futuresApi.getFuturesContract(settle, `${symbol}_USDT`);
            findFutureContract = futureContract.body;
        } catch (e) {
            console.log("获取合约详细信息失败", e);
            // 检查是否是合约不存在的错误
            if (e.response && e.response.data && e.response.data.label === "CONTRACT_NOT_FOUND") {
                return res.status(400).json({success: false, message: '合约不存在', error: e.message});
            }
            throw e;
        }
        
        // 4. 格式化保护止损价格
        const formattedPrice = formatPrice(protectionPrice.toString(), findFutureContract.orderPriceRound);
        
        if (Number(formattedPrice) > 0) {
            // 5. 清除该合约旧的止损条件单，保留止盈条件单
            try {
                const priceTriggeredOrder = await futuresApi.listPriceTriggeredOrders(settle, "open", {
                    contract: `${symbol}_USDT`,
                });
                await new Promise(resolve => setTimeout(resolve, 200));
                
                // 过滤出止损条件单
                const stopLossOrders = priceTriggeredOrder.body.filter(order => {
                    // 根据订单类型判断是否为止损单
                    return order.orderType === "close-long-position" || order.orderType === "close-short-position";
                });
                
                if (stopLossOrders.length > 0) {
                    await futuresApi.cancelPriceTriggeredOrderList(settle, {contract: `${symbol}_USDT`});
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            } catch (e) {
                console.log("清除旧止损条件单失败", e);
            }
            
            // 6. 创建新的保护止损条件单
            await futuresApi.createPriceTriggeredOrder(settle, {
                initial: {
                    contract: `${symbol}_USDT`,
                    size: 0, // 0 表示平掉当前所有持仓
                    price: "0", // 触发后的委托价格，0 表示市价
                    reduceOnly: true, // 只减仓
                    close: true,
                    tif: "ioc",
                },
                trigger: {
                    strategyType: 0, // 策略类型 0
                    priceType: 0, // 价格类型 0 (标记价格)
                    price: formattedPrice, // 触发价格
                    rule: direction === "buy" ? 2 : 1 // 规则: 买入时止损触发规则为 2 (低于), 卖出时为 1 (高于)
                },
                orderType: direction === "buy" ? "close-long-position" : "close-short-position", // 订单类型
            });
            
            console.log(`用户 ${userOptions.userId} 的 ${symbol} 保护止损单已更新，价格为 ${formattedPrice}`);  
            return res.status(200).json({success: true, message: '保护止损单更新成功'});
        }

        return res.status(200).json({success: false, message: '保护止损价格无效'});
    } catch (e) {
        console.log("更新保护止损单出错", e);
        return res.status(500).json({success: false, message: '更新保护止损单出错', error: e.message});
    }
};

export const gateTrade = async ({ tradeData, userOptions }) => {
    try {
        // 1. 初始化 API 客户端
        const {apiKey, apiSecret, isTestOption, currency} = userOptions
        client.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
        client.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL
        
        // 2. 初始化期货 API 接口
        const futuresApi = new GateApi.FuturesApi(client);
        const settle = "usdt" // 结算货币为 USDT 本位合约
        const futureContractData = []
        let filterTradeDate = null
        
        // 3. 过滤交易品种
        if (!isEmpty(currency)) {
            // 如果用户指定了 currency 列表，则只保留 tradeData 中 symbol 匹配的币种
            filterTradeDate = intersectionWith(tradeData, currency, (a, b) => `${a.symbol}_USDT` === b)
        } else {
            filterTradeDate = tradeData
        }
        
        // 4. 获取所有合约信息
        const allContracts = await futuresApi.listFuturesContracts(settle);
        
        // 5. 过滤出有效的合约
        for (const tradeItem of filterTradeDate) {
            const contractInfo = allContracts.body.find(contract => contract.contract === `${tradeItem.symbol}_USDT`);
            if (contractInfo) {
                futureContractData.push({
                    ...tradeItem,
                    contractInfo
                })
            }
        }
        
        // 6. 执行交易
        if (userOptions.isActive) {
            const {direction, maxVolume, leverage, stopLoss, takeProfit} = userOptions
            
            // 7. 获取账户信息并保存
            const accountInfo = await futuresApi.listFuturesAccounts(settle);
            const accountFunds = {
                total: accountInfo.body.total,
                unrealisedPnl: accountInfo.body.unrealisedPnl,
                available: accountInfo.body.available
            }
            await saveUserBalance(userOptions.userId, accountFunds)
            
            // 8. 遍历处理每个交易信号
            for (const item of futureContractData) {
                if (direction === 'all' || direction === item.direction) {
                    try {
                        const {symbol, direction, contractInfo} = item
                        const symbolName = `${symbol}_USDT`
                        
                        // 9. 检查当前持仓
                        let currentPosition
                        try {
                            currentPosition = await futuresApi.getPosition(settle, symbolName);
                        } catch (e) {
                            console.log(`获取 ${symbol} 持仓失败，可能没有持仓:`, e.message);
                            currentPosition = null;
                        }
                        
                        // 10. 处理反向持仓
                        if (currentPosition && currentPosition.body.size !== 0) {
                            const currentDirection = currentPosition.body.size > 0 ? 'LONG' : 'SHORT';
                            if ((currentDirection === 'LONG' && direction === 'SHORT') ||
                                (currentDirection === 'SHORT' && direction === 'LONG')) {
                                console.log(`发现反向持仓，先平仓: ${currentDirection}`);
                                
                                // 调整杠杆
                                await futuresApi.updatePositionLeverage(settle, symbolName, currentPosition.body.leverage, {});
                                await new Promise(resolve => setTimeout(resolve, 100));
                                
                                // 平仓
                                const closeOrder = await futuresApi.createFuturesOrder(settle, {
                                    contract: symbolName,
                                    size: currentPosition.body.size < 0 ? Math.abs(currentPosition.body.size) : -currentPosition.body.size,
                                    price: 0,
                                    tif: "ioc",
                                }, {});
                                await new Promise(resolve => setTimeout(resolve, 100));
                                
                                console.log(`平仓成功: ${symbol}`, closeOrder.body);
                            }
                        }
                        
                        // 11. 计算下单数量
                        const orderPrice = contractInfo.markPrice || contractInfo.lastPrice;
                        const quantity = (maxVolume * 1000000) / orderPrice; // 计算数量
                        
                        // 12. 调整杠杆
                        await futuresApi.updatePositionLeverage(settle, symbolName, leverage, {});
                        await new Promise(resolve => setTimeout(resolve, 100));
                        
                        // 13. 下单
                        const orderSide = direction === 'LONG' ? 1 : -1;
                        const order = await futuresApi.createFuturesOrder(settle, {
                            contract: symbolName,
                            size: orderSide * Math.abs(quantity),
                            price: 0, // 市价单
                            tif: "ioc",
                        }, {});
                        await new Promise(resolve => setTimeout(resolve, 100));
                        
                        console.log('下单成功:', order.body);
                        
                        // 14. 保存交易记录
                        if (order.body.orderId) {
                            try {
                                await saveTradeRecord({
                                    userId: userOptions.userId,
                                    symbol: `${item.symbol}`,
                                    price: String(order.body.fillPrice || orderPrice),
                                    size: String(Math.abs(quantity)),
                                    direction: item.direction,
                                    exchange: 'gate',
                                    orderId: order.body.orderId.toString(),
                                    leverage: String(leverage),
                                    status: 'pending'  // 先设为待处理状态
                                });
                                
                                console.log(`交易记录保存成功: ${order.body.orderId}`);
                            } catch (error) {
                                console.error(`交易记录保存失败: ${error.message}`);
                                // 继续执行，不因记录保存失败而中断交易流程
                            }
                        }
                        
                    } catch (error) {
                        console.error(`交易失败: ${error.message}`);
                        // 继续处理下一个交易对
                        continue;
                    }
                }
            }
        }
    } catch (error) {
        console.error('交易失败:', error);
    }
};

/**
 * 获取 Gate 交易所的持仓信息
 * @param {Object} userOptions - 用户配置
 * @returns {Promise<Array>} 持仓信息列表
 */
export const getGatePositions = async (userOptions) => {
    try {
        const {apiKey, apiSecret, isTestOption} = userOptions;
        client.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
        client.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL;
        
        const futuresApi = new GateApi.FuturesApi(client);
        const settle = "usdt";
        
        // 获取所有持仓
        const positions = await futuresApi.listPositions(settle);
        
        // 转换为统一格式
        return positions.body
            .filter(position => position.size !== 0) // 只返回有持仓的
            .map(position => ({
                symbol: position.contract.replace('_USDT', ''),
                direction: position.size > 0 ? 'buy' : 'sell',
                entryPrice: position.avgPrice,
                size: Math.abs(position.size),
                exchange: 'gate',
                unrealisedPnl: position.unrealisedPnl
            }));
    } catch (error) {
        console.error('获取 Gate 持仓信息失败:', error);
        return [];
    }
};