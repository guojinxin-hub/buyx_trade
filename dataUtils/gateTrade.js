import {intersectionWith, isEmpty} from "lodash";
import {formatPrice} from "./formatPrice.js";
import {decrypt} from "./utils/index.js";
import {saveTradeRecord} from "./saveTradeRecord.js";
import {getAddPositionDecision} from "./addPositionRule.js";
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
            // 5. 清除该合约旧的止损条件单（保留止盈条件单）
            try {
                const priceTriggeredOrder = await futuresApi.listPriceTriggeredOrders(settle, "open", {
                    contract: `${symbol}_USDT`,
                });
                await new Promise(resolve => setTimeout(resolve, 500));

                // 只删除旧止损单：做多止损=跌破触发(rule 2)，做空止损=涨破触发(rule 1)；止盈单规则相反，予以保留
                const stopLossOrders = priceTriggeredOrder.body.filter(order => {
                    if (order.orderType !== "close-long-position" && order.orderType !== "close-short-position") {
                        return false;
                    }
                    return Number(order.trigger?.rule) === (direction === "buy" ? 2 : 1);
                });

                for (const order of stopLossOrders) {
                    await futuresApi.cancelPriceTriggeredOrder(settle, order.id);
                    await new Promise(resolve => setTimeout(resolve, 300));
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
            await saveUserBalance(userOptions.userId, futureAccount.body, userOptions.belong)
            
            // 5.2 检查并修改持仓模式（设置为单向持仓）
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
            }
            
            // 5.3 匹配交易数据与合约数据
            const intersectionData = intersectionWith(filterTradeDate, futureContractData, (a, b) => `${a.symbol}_USDT` === b.name)

            // 5.4 遍历处理每个交易信号
            for (const item of intersectionData) {
                try {
                    const {symbol, direction, limitPrice, entryType} = item
                    console.log("Gate symbol: ", symbol, "direction: ", direction, "entryType: ", entryType, "limitPrice: ", limitPrice)
                    
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
                        await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions, null, false, limitPrice, entryType)
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
                        await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions, null, false, limitPrice, entryType)
                    } 
                    // 逻辑 C: 持仓方向与信号一致 -> 按加仓规则（每日1次/最多3次/按盈亏比例）决定加仓资金
                    else if (position && ((Number(position.body.size) > 0 && direction === "buy") || (Number(position.body.size) < 0 && direction === "sell"))) {
                        const decision = await getAddPositionDecision({
                            userId: userOptions.userId,
                            symbol,
                            maxVolume: Number(userOptions.maxVolume),
                            upl: Number(position.body.unrealised_pnl) || 0,
                            exchange: 'gate',
                            direction
                        });
                        if (decision) {
                            await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions, decision.addUsdt, true, limitPrice, entryType);
                        } else {
                            console.log(`Gate ${symbol} 不满足加仓条件，跳过加仓`)
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

// 下单（usdtAmount：下单资金，同向加仓时由加仓规则传入，入场/反手时不传则用原始单资金 maxVolume）
// entryType：'limit'=逆势策略限价挂单（最近4日高低中值，24小时未成交自动撤单）；'market'=顺势策略市价突破入场
// isAddPosition：是否为同向加仓。加仓时保留原有止盈止损条件单（size=0 全仓平仓，天然覆盖新增仓位），不重挂
const createOrder = async (futuresApi, futureContractData, settle, symbol, direction, userOptions, usdtAmount, isAddPosition = false, limitPrice, entryType = 'market') => {
    try {
        console.log("Gate下单", userOptions.userId)
        const orderUsdt = Number(usdtAmount) || Number(userOptions.maxVolume)
        const isLimitEntry = entryType === 'limit'
        
        // 1. 检查用户是否允许该方向的交易 (userOptions.direction 为 "all", "buy" 或 "sell")
        if ((userOptions.direction === "all") || userOptions.direction === direction) {
            
            // 2. 获取账户余额并检查可用资金
            const futureAccount = await futuresApi.listFuturesAccounts(settle)
            // 计算公式：可用余额 - 保险资金 > (下单金额 / 杠杆)
            // 这里的逻辑是确保除去保险金后，剩下的钱足以开仓
            const canTrade = (Number(futureAccount.body.available) - Number(userOptions.insurance)) > (orderUsdt / Number(userOptions.leverage))
            
            if (canTrade) {
                // 3. 计算下单数量
                const findFutureContract = futureContractData.find(item => item.name === `${symbol}_USDT`)

                // 限价委托必须带有效委托价；市价单使用标记价计算张数
                let formattedLimitPrice = null
                if (isLimitEntry) {
                    formattedLimitPrice = formatPrice(limitPrice, findFutureContract.orderPriceRound)
                    if (Number(formattedLimitPrice) <= 0) {
                        console.log(`Gate ${symbol} 缺少有效委托价，跳过下单`)
                        return
                    }
                }
                const priceForSize = isLimitEntry ? formattedLimitPrice : Number(findFutureContract.markPrice)

                // 计算逻辑：(下单金额 / (合约乘数 * 价格)) * 杠杆倍数
                // 注意：这里计算的是张数
                const size = Math.floor(orderUsdt / (Number(findFutureContract.quantoMultiplier) * Number(priceForSize)) * Number(userOptions.leverage))
                
                if (size > 0) {
                    // 4. 设置杠杆
                    // 杠杆倍数取用户设置和合约最大杠杆的最小值
                    await futuresApi.updatePositionLeverage(settle, `${symbol}_USDT`, `${Math.min(userOptions.leverage, findFutureContract.leverageMax)}`, {})
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // 5. 下单：限价单 gtc 一直有效（24小时未成交由 limitEntryManager 撤单）；市价单 ioc
                    const createFuturesOrder = await futuresApi.createFuturesOrder(settle, {
                        contract: `${symbol}_USDT`,
                        size: direction === "buy" ? size : -size, // 买入为正，卖出为负
                        price: isLimitEntry ? formattedLimitPrice : 0,
                        tif: isLimitEntry ? "gtc" : "ioc",
                    }, {})

                    // 6. 止盈止损
                    //    - 市价单立即成交：直接按成交价挂止盈止损（与旧逻辑一致）
                    //    - 限价单可能不成交：交易所不允许无持仓挂平仓条件单，成交后由 limitEntryManager 补挂
                    if (!isLimitEntry && !isAddPosition) {
                        try {
                            await placeGateProtection({
                                userOptions,
                                symbol,
                                direction,
                                entryPrice: Number(createFuturesOrder.body.fillPrice),
                                futuresApi,
                                contract: findFutureContract
                            })
                        } catch (e) {
                            console.error(`Gate ${symbol} 市价入场后挂止盈止损失败:`, e.message)
                        }
                    }

                    // 保存交易记录
                    if (createFuturesOrder?.body?.id) {
                        try {
                            await saveTradeRecord(userOptions.userId, {
                                symbol: `${symbol}`,
                                price: isLimitEntry ? String(formattedLimitPrice) : String(createFuturesOrder.body.fillPrice),
                                size: String(Math.abs(size)),
                                direction: direction,
                                exchange: 'gate',
                                orderId: createFuturesOrder.body.id,
                                leverage: String(Math.min(userOptions.leverage, findFutureContract.leverageMax)),
                                status: 'pending',  // 先设为待处理状态
                                orderType: isLimitEntry ? 'limit' : 'market',
                                limitPrice: isLimitEntry ? String(formattedLimitPrice) : undefined,
                                entryFilled: !isLimitEntry || isAddPosition, // 市价单已成交（止盈止损已挂）；限价单待成交后登记
                                isAddPosition: !!isAddPosition // 加仓单沿用原止盈止损，不补挂
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

/**
 * 止盈止损挂单（Gate）
 * 市价入场时直接按成交价挂；限价入场单成交后由 limitEntryManager 按持仓均价挂
 * @param {Object} params
 * @param {Object} params.userOptions - 用户交易配置
 * @param {string} params.symbol - 币种
 * @param {string} params.direction - buy/sell
 * @param {string|number} params.entryPrice - 实际入场价（市价单传成交价，限价单传持仓均价）
 * @param {Object} [params.futuresApi] - 复用已初始化的 FuturesApi（可选）
 * @param {Object} [params.contract] - 复用已获取的合约信息（可选）
 * @returns {Promise<boolean>} 是否成功
 */
export const placeGateProtection = async ({userOptions, symbol, direction, entryPrice, futuresApi: providedApi, contract: providedContract}) => {
    try {
        let futuresApi = providedApi
        const settle = "usdt"

        if (!futuresApi) {
            const {apiKey, apiSecret, isTestOption} = userOptions
            const gateClient = new GateApi.ApiClient();
            gateClient.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
            gateClient.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL
            futuresApi = new GateApi.FuturesApi(gateClient)
        }

        const contract = providedContract || (await futuresApi.getFuturesContract(settle, `${symbol}_USDT`)).body
        const entry = Number(entryPrice)
        if (!Number.isFinite(entry) || entry <= 0) return false

        const stopLossPercent = Number(userOptions.stopLoss)
        const takeProfitPercent = Number(userOptions.takeProfit)

        // 先清理该合约旧的止盈止损条件单，避免重复挂单
        try {
            const existing = await futuresApi.listPriceTriggeredOrders(settle, "open", {contract: `${symbol}_USDT`})
            if (existing.body && existing.body.length > 0) {
                await futuresApi.cancelPriceTriggeredOrderList(settle, {contract: `${symbol}_USDT`})
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (e) {
            console.log(`Gate ${symbol} 清理旧条件单失败(忽略):`, e.message)
        }

        // 止损：买入止损价 = 入场价 × (1 - 止损%)；卖出止损价 = 入场价 × (1 + 止损%)
        if (stopLossPercent > 0) {
            const stopLossPrice = direction === "buy"
                ? `${(1 - (stopLossPercent / 100)) * entry}`
                : `${(1 + (stopLossPercent / 100)) * entry}`
            const price = formatPrice(stopLossPrice, contract.orderPriceRound)

            if (Number(price) > 0) {
                await futuresApi.createPriceTriggeredOrder(settle, {
                    initial: {
                        contract: `${symbol}_USDT`,
                        size: 0, // 0 表示平掉当前所有持仓
                        price: "0", // 触发后的委托价格，0 表示市价
                        reduceOnly: true,
                        close: true,
                        tif: "ioc",
                    },
                    trigger: {
                        strategyType: 0,
                        priceType: 0,
                        price: price,
                        rule: direction === "buy" ? 2 : 1 // 买入时止损触发规则为 2 (低于)，卖出时为 1 (高于)
                    },
                    orderType: direction === "buy" ? "close-long-position" : "close-short-position",
                })
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        // 止盈：买入止盈价 = 入场价 × (1 + 止盈%)；卖出止盈价 = 入场价 × (1 - 止盈%)
        if (takeProfitPercent > 0) {
            const profitPrice = direction === "buy"
                ? `${(1 + (takeProfitPercent / 100)) * entry}`
                : `${(1 - (takeProfitPercent / 100)) * entry}`
            const price = formatPrice(profitPrice, contract.orderPriceRound)

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
                        rule: direction === "buy" ? 1 : 2 // 买入时止盈触发规则为 1 (高于)，卖出时为 2 (低于)
                    },
                    orderType: direction === "buy" ? "close-long-position" : "close-short-position",
                })
            }
        }

        console.log(`Gate ${symbol} 限价单成交，已按入场价 ${entry} 补挂止盈止损`)
        return true
    } catch (e) {
        console.log(`Gate ${symbol} 补挂止盈止损失败:`, e.message)
        return false
    }
}

/**
 * 获取 Gate 当前挂单列表
 * @param {Object} userOptions - 用户交易配置
 * @returns {Promise<Object>} { futuresApi, settle, orders }
 */
export const getGateOpenOrders = async (userOptions) => {
    const {apiKey, apiSecret, isTestOption} = userOptions
    const gateClient = new GateApi.ApiClient();
    gateClient.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
    gateClient.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL
    const futuresApi = new GateApi.FuturesApi(gateClient)
    const settle = "usdt"

    const res = await futuresApi.listFuturesOrders(settle, "open", {limit: 100})
    return {futuresApi, settle, orders: (res.body || []).map(o => ({...o, orderId: o.id}))}
}

/**
 * 撤销 Gate 挂单
 */
export const cancelGateOrder = async ({futuresApi, settle, orderId}) => {
    return futuresApi.cancelFuturesOrder(settle, orderId)
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
                    unrealisedPnl: profitPercentage,
                    absolutePnl: parseFloat(position.unrealisedProfit) || 0,
                    leverage: position.leverage
                };
            });
    } catch (error) {
        console.error('获取 Gate 持仓信息失败:', error);
        return [];
    }
};