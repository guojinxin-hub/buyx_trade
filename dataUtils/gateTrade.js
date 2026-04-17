import {intersectionWith, isEmpty} from "lodash";
import {formatPrice} from "./formatPrice.js";
import {decrypt} from "./utils/index.js";
import {saveTradeRecord} from "./saveTradeRecord.js";
import {saveUserBalance} from "./saveUserBalance.js";
import moment from "moment";

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
                await new Promise(resolve => setTimeout(resolve, 500));
                
                const stopLossOrders = priceTriggeredOrder.body.filter(order => {
                    return order.orderType === "close-long-position" || order.orderType === "close-short-position";
                });
                
                if (stopLossOrders.length > 0) {
                    await futuresApi.cancelPriceTriggeredOrderList(settle, {contract: `${symbol}_USDT`});
                    await new Promise(resolve => setTimeout(resolve, 800));
                }
            } catch (e) {
                console.log("清除旧止损条件单失败", e);
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            
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
            
            await new Promise(resolve => setTimeout(resolve, 300));
            
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
        console.log(moment().format("YYYY-MM-DD HH:mm:ss"),userOptions.userId,"Gate 交易开始");
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
            // 否则使用所有交易数据
            filterTradeDate = tradeData
        }
        
        // 4. 获取合约详细信息（如价格精度、最小下单量等）
        for (const tradeItem of filterTradeDate) {
            try {
                const futureContract = await futuresApi.getFuturesContract(settle, `${tradeItem.symbol}_USDT`)
                futureContractData.push(futureContract.body)
                await new Promise(resolve => setTimeout(resolve, 200)); // 休眠 100ms 避免触发限流
            } catch (e) {
                //  console.log("获取合约币种出错", e)
            }
        }
        console.log(moment().format("YYYY-MM-DD HH:mm:ss"),userOptions.userId,"币种",futureContractData);

        // 5. 检查用户是否激活交易
        if (userOptions.isActive) {
            // 5.1 获取并保存账户余额
            const futureAccount = await futuresApi.listFuturesAccounts(settle)
            await saveUserBalance(userOptions.userId, futureAccount.body)
            
            // 5.2 检查并修改持仓模式（双向 -> 单向）
            let inDualMode = futureAccount.body.inDualMode
            if (inDualMode) {
                const positions = await futuresApi.listPositions(settle, {holding: true})
                if (isEmpty(positions.body)) {
                    try {
                        const dualModeResult = await futuresApi.setDualMode(settle, false)
                        inDualMode = dualModeResult.body.inDualMode
                    } catch (e) {
                        console.log("修改持仓模式失败", e)
                    }
                }
            }
            if (inDualMode) {
                console.log("持仓方向应该为单向持仓")
                // 注意：这里只是打印了日志，代码逻辑似乎并未强制阻止后续下单，
                // 但通常在双向模式下无法直接使用此脚本逻辑（因为脚本逻辑基于净持仓 size）。
            }
            
            // 5.3 匹配交易数据与合约数据
            const intersectionData = intersectionWith(filterTradeDate, futureContractData, (a, b) => `${a.symbol}_USDT` === b.name)

            // 5.4 遍历处理每个交易信号
            for (const item of intersectionData) {
                try {
                    const {symbol, direction} = item
                    console.log("Gate symbol: ", symbol, "direction: ", direction)
                    
                    // 获取当前持仓
                    let position = null
                    try {
                        position = await futuresApi.getPosition(settle, `${symbol}_USDT`)
                    } catch (e) {
                        // console.log("没有仓位", e)
                    }
                    console.log("position: ", position?.body)
                    // 逻辑 A: 没有持仓 -> 开仓
                    if (!position || (position && Number(position.body.size) === 0)) {
                        await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions)
                    } 
                    // 逻辑 B: 持仓方向与信号相反 (如持多收到卖空信号) -> 反手 (先平后开)
                    else if (position && ((Number(position.body.size) < 0 && direction === "buy") || (Number(position.body.size) > 0 && direction === "sell"))) {
                        // 1. 调整杠杆（确保平仓时杠杆正确，虽然平仓通常不需要特定杠杆，但为了安全）
                        await futuresApi.updatePositionLeverage(settle, `${symbol}_USDT`, position.body.leverage, {})
                        await new Promise(resolve => setTimeout(resolve, 200));
                        
                        // 2. 下市价平仓单 (price=0, tif='ioc' 即立即成交或取消)
                        await futuresApi.createFuturesOrder(settle, {
                            contract: `${symbol}_USDT`,
                            size: Number(position.body.size) < 0 ? Math.abs(Number(position.body.size)) : -Number(position.body.size),
                            price: 0,
                            tif: "ioc",
                        }, {})
                        await new Promise(resolve => setTimeout(resolve, 200));
                        
                        // 3. 反手开新仓
                        await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions)
                    } 
                    // 逻辑 C: 持仓方向与信号一致 -> 只有盈利时才加仓
                    else if (position && ((Number(position.body.size) > 0 && direction === "buy") || (Number(position.body.size) < 0 && direction === "sell"))) {
                        if (Number(position.body.unrealisedPnl) > 0) {
                            await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions)
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (e) {
                    console.log("Gate", e)
                }
            }
        }
    } catch (e) {
        console.log("Gate", e)
    }
}

// 下单
const createOrder = async (futuresApi, futureContractData, settle, symbol, direction, userOptions) => {
    try {
        console.log("Gate下单", userOptions.userId)
        
        // 1. 检查用户是否允许该方向的交易 (userOptions.direction 为 "all", "buy" 或 "sell")
        if ((userOptions.direction === "all") || userOptions.direction === direction) {
            
            // 2. 获取账户余额并检查可用资金
            const futureAccount = await futuresApi.listFuturesAccounts(settle)
            // 计算公式：可用余额 - 保险资金 > (最大下单金额 / 杠杆)
            // 这里的逻辑是确保除去保险金后，剩下的钱足以开仓
            const canTrade = (Number(futureAccount.body.available) - Number(userOptions.insurance)) > (Number(userOptions.maxVolume) / Number(userOptions.leverage))
            
            if (canTrade) {
                // 3. 计算下单数量
                const findFutureContract = futureContractData.find(item => item.name === `${symbol}_USDT`)
                // 计算逻辑：(最大下单金额 / (合约乘数 * 标记价格)) * 杠杆倍数
                // 注意：这里计算的是张数
                const size = Math.floor(Number(userOptions.maxVolume) / (Number(findFutureContract.quantoMultiplier) * Number(findFutureContract.markPrice)) * Number(userOptions.leverage))
                
                if (size > 0) {
                    // 4. 设置杠杆
                    // 杠杆倍数取用户设置和合约最大杠杆的最小值
                    await futuresApi.updatePositionLeverage(settle, `${symbol}_USDT`, `${Math.min(userOptions.leverage, findFutureContract.leverageMax)}`, {})
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // 5. 下市价单
                    const createFuturesOrder = await futuresApi.createFuturesOrder(settle, {
                        contract: `${symbol}_USDT`,
                        size: direction === "buy" ? size : -size, // 买入为正，卖出为负
                        price: 0, // 0 代表市价单
                        tif: "ioc", // Immediate or Cancel (立即成交或取消)
                    }, {})
                    
                    // 6. 计算止损价格并挂单
                    // 买入止损价 = 成交价 * (1 - 止损百分比%)
                    // 卖出止损价 = 成交价 * (1 + 止损百分比%)
                    const lossPrice = direction === "buy" ? 
                        `${(1 - (Number(userOptions.stopLoss) / 100)) * Number(createFuturesOrder.body.fillPrice)}` : 
                        `${(1 + (Number(userOptions.stopLoss) / 100)) * Number(createFuturesOrder.body.fillPrice)}`
                    
                    const price = formatPrice(lossPrice, findFutureContract.orderPriceRound)
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // 6.1 清除该合约旧的止盈止损条件单 (避免重复挂单)
                    const priceTriggeredOrder = await futuresApi.listPriceTriggeredOrders(settle, "open", {
                        contract: `${symbol}_USDT`,
                    })
                    await new Promise(resolve => setTimeout(resolve, 200));
                    if (priceTriggeredOrder.body.length > 0) {
                        await futuresApi.cancelPriceTriggeredOrderList(settle, {contract: `${symbol}_USDT`})
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                    
                    // 6.2 创建止损条件单 (条件单类型为平仓)
                    if (Number(price) > 0) {
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
                                price: price, // 触发价格
                                rule: direction === "buy" ? 2 : 1 // 规则: 买入时止损触发规则为 2 (低于), 卖出时为 1 (高于)
                            },
                            orderType: direction === "buy" ? "close-long-position" : "close-short-position", // 订单类型
                        })
                    }
                    
                    // 7. 计算止盈价格并挂单 (如果用户配置了止盈)
                    if (userOptions.takeProfit) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                        // 买入止盈价 = 成交价 * (1 + 止盈百分比%)
                        // 卖出止盈价 = 成交价 * (1 - 止盈百分比%)
                        const profitPrice = direction === "buy" ? 
                            `${(1 + (Number(userOptions.takeProfit) / 100)) * Number(createFuturesOrder.body.fillPrice)}` : 
                            `${(1 - (Number(userOptions.takeProfit) / 100)) * Number(createFuturesOrder.body.fillPrice)}`
                        
                        const price = formatPrice(profitPrice, findFutureContract.orderPriceRound)
                        
                        if (Number(price) > 0) {
                            await futuresApi.createPriceTriggeredOrder(settle, {
                                initial: {
                                    contract: `${symbol}_USDT`,
                                    size: 0,
                                    price: "0",
                                    reduceOnly: true,
                                    tif: "ioc",
                                    close: true,
                                },
                                trigger: {
                                    strategyType: 0,
                                    priceType: 0,
                                    price: price,
                                    rule: direction === "buy" ? 1 : 2 // 规则: 买入时止盈触发规则为 1 (高于), 卖出时为 2 (低于)
                                },
                                orderType: direction === "buy" ? "close-long-position" : "close-short-position",
                            })
                        }
                    }

                    // 保存交易记录
                    if (createFuturesOrder?.body?.id) {
                        try {
                            await saveTradeRecord(userOptions.userId, {
                                symbol: `${symbol}`,
                                price: String(createFuturesOrder.body.fillPrice),
                                size: String(Math.abs(size)),
                                direction: direction,
                                exchange: 'gate',
                                orderId: createFuturesOrder.body.id,
                                leverage: String(Math.min(userOptions.leverage, findFutureContract.leverageMax)),
                                status: 'pending'  // 先设为待处理状态
                            });
                            
                            console.log(`交易记录保存成功: ${createFuturesOrder.body.id}`);
                            
                            
                        } catch (error) {
                            console.error(`交易记录保存或状态更新失败: ${error.message}`);
                            // 继续执行，不因记录保存失败而中断交易流程
                        }
                    }

                }
                console.log("success")
            } else {
                console.log(userOptions.userId + "保证金不足")
            }
        }
    } catch (e) {
        console.log("Gate 下单出错", e)
    }
}

export const getGatePositions = async (userOptions) => {
    try {
        const {apiKey, apiSecret, isTestOption} = userOptions;
        client.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
        client.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL;
        
        const futuresApi = new GateApi.FuturesApi(client);
        const settle = "usdt";
        
        const positions = await futuresApi.listPositions(settle);
        return positions.body
            .filter(position => position.size !== 0)
            .map(position => {
                const entryPrice = parseFloat(position.entryPrice) || 0;
                const markPrice = parseFloat(position.markPrice) || 0;
                const leverage = parseFloat(position.leverage) || 1;
                
                // 计算收益率: (当前价格 - 入场价格) / 入场价格 * 杠杆 * 100%
                let profitPercentage = 0;
                if (entryPrice > 0 && markPrice > 0) {
                    const priceDiff = position.size > 0 
                        ? (markPrice - entryPrice) / entryPrice  // 做多
                        : (entryPrice - markPrice) / entryPrice; // 做空
                    profitPercentage = priceDiff * 100;
                }
                return {
                    symbol: position.contract.replace('_USDT', ''),
                    direction: position.size > 0 ? 'buy' : 'sell',
                    entryPrice: position.entryPrice,
                    avgPrice: position.entryPrice,
                    markPrice: position.markPrice,
                    lastPrice: position.markPrice,
                    currentPrice: position.markPrice,
                    size: Math.abs(position.size),
                    exchange: 'gate',
                    unrealisedPnl: profitPercentage, // 返回计算后的收益率百分比
                    leverage: position.leverage
                };
            });
    } catch (error) {
        console.error('获取 Gate 持仓信息失败:', error);
        return [];
    }
};