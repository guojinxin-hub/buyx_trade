import {intersectionWith, isEmpty} from "lodash";
import {formatPrice} from "./formatPrice";
import {decrypt} from "./utils";
import {saveUserBalance} from "./saveUserBalance";

const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL
let client = new GateApi.ApiClient();

export const gateTrade = async ({
                                    tradeData,
                                    userOptions,
                                }) => {
    try {
        const {apiKey, apiSecret, isTestOption, currency} = userOptions
        client.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
        client.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL
        const futuresApi = new GateApi.FuturesApi(client);
        const settle = "usdt"
        const futureContractData = []
        let filterTradeDate = null
        if (!isEmpty(currency)) {
            filterTradeDate = intersectionWith(tradeData, currency, (a, b) => `${a.symbol}` === b)
        } else {
            filterTradeDate = tradeData
        }
        for (const tradeItem of filterTradeDate) {
            try {
                const futureContract = await futuresApi.getFuturesContract(settle, `${tradeItem.symbol}_USDT`)
                futureContractData.push(futureContract.body)
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (e) {
                //  console.log("获取合约币种出错", e)
            }
        }
        if (userOptions.isActive) {
            const futureAccount = await futuresApi.listFuturesAccounts(settle)
            await saveUserBalance(userOptions.userId, futureAccount.body)
            // 获取用户的账户信息，查看持仓模式，如果是双向持仓，则需要改为单向持仓
            // 如果持仓模式修改不成功则拒绝下单操作
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
            const intersectionData = intersectionWith(filterTradeDate, futureContractData, (a, b) => `${a.symbol}_USDT` === b.name)
            for (const item of intersectionData) {
                try {
                    const {symbol, direction} = item
                    console.log("symbol: ", symbol, "direction: ", direction)
                    let position = null
                    try {
                        position = await futuresApi.getPosition(settle, `${symbol}_USDT`)
                    } catch (e) {
                        // console.log("没有仓位", e)
                    }
                    if (!position || (position && position.body.size === 0)) {
                        await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions)
                    } else if (position && ((position.body.size < 0 && direction === "buy") || (position.body.size > 0 && direction === "sell"))) {
                        // 进行平仓操作
                        await futuresApi.updatePositionLeverage(settle, `${symbol}_USDT`, position.body.leverage, {})
                        await new Promise(resolve => setTimeout(resolve, 100));
                        await futuresApi.createFuturesOrder(settle, {
                            contract: `${symbol}_USDT`,
                            size: position.body.size < 0 ? Math.abs(position.body.size) : -position.body.size,
                            price: 0,
                            tif: "ioc",
                        }, {})
                        await new Promise(resolve => setTimeout(resolve, 100));
                        // 进行反手操作
                        await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions)
                    } else if (position && ((position.body.size > 0 && direction === "buy") || (position.body.size < 0 && direction === "sell"))) {
                        // 方向一致，如果状态为盈利，则进行加仓操作
                        if (Number(position.body.unrealisedPnl) > 0) {
                            // 进行加仓操作
                            await createOrder(futuresApi, futureContractData, settle, symbol, direction, userOptions)
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (e) {
                    console.log("e", e)
                }
            }
        }
    } catch (e) {
        console.log("e", e)
    }
}

// 下单
const createOrder = async (futuresApi, futureContractData, settle, symbol, direction, userOptions) => {
    try {
        console.log("下单", userOptions.userId)
        if ((userOptions.direction === "all") || userOptions.direction === direction) {
            const futureAccount = await futuresApi.listFuturesAccounts(settle)
            const canTrade = (Number(futureAccount.body.available) - Number(userOptions.insurance)) > (Number(userOptions.maxVolume) / Number(userOptions.leverage))
            if (canTrade) {
                const findFutureContract = futureContractData.find(item => item.name === `${symbol}_USDT`)
                const size = Math.floor(Number(userOptions.maxVolume) / (Number(findFutureContract.quantoMultiplier) * Number(findFutureContract.markPrice)) * Number(userOptions.leverage))
                if (size > 0) {
                    // 用户下单，拿到用户的止盈止损设置
                    // 首先先开仓下单
                    // 设置用户的杠杆倍数
                    await futuresApi.updatePositionLeverage(settle, `${symbol}_USDT`, `${Math.min(userOptions.leverage, findFutureContract.leverageMax)}`, {})
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const createFuturesOrder = await futuresApi.createFuturesOrder(settle, {
                        contract: `${symbol}_USDT`,
                        size: direction === "buy" ? size : -size,
                        price: 0,
                        tif: "ioc",
                    }, {})
                    const lossPrice = direction === "buy" ? `${(1 - (Number(userOptions.stopLoss) / 100)) * Number(createFuturesOrder.body.fillPrice)}` : `${(1 + (Number(userOptions.stopLoss) / 100)) * Number(createFuturesOrder.body.fillPrice)}`
                    const price = formatPrice(lossPrice, findFutureContract.orderPriceRound)
                    await new Promise(resolve => setTimeout(resolve, 100));
                    // 创建条件单之前需要判断是否已经存在挂单行为
                    const priceTriggeredOrder = await futuresApi.listPriceTriggeredOrders(settle, "open", {
                        contract: `${symbol}_USDT`,
                    })
                    await new Promise(resolve => setTimeout(resolve, 100));
                    if (priceTriggeredOrder.body.length > 0) {
                        await futuresApi.cancelPriceTriggeredOrderList(settle, {contract: `${symbol}_USDT`})
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                    if (Number(price) > 0) {
                        await futuresApi.createPriceTriggeredOrder(settle, {
                            initial: {
                                contract: `${symbol}_USDT`,
                                size: 0,// 平仓
                                price: "0",// 止损
                                reduceOnly: true,
                                close: true,
                                tif: "ioc",
                            },
                            trigger: {
                                strategyType: 0,
                                priceType: 0,
                                price: price,
                                rule: direction === "buy" ? 2 : 1
                            },
                            orderType: direction === "buy" ? "close-long-position" : "close-short-position",
                        })
                    }
                    if (userOptions.takeProfit) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const profitPrice = direction === "buy" ? `${(1 + (Number(userOptions.takeProfit) / 100)) * Number(createFuturesOrder.body.fillPrice)}` : `${(1 - (Number(userOptions.takeProfit) / 100)) * Number(createFuturesOrder.body.fillPrice)}`
                        const price = formatPrice(profitPrice, findFutureContract.orderPriceRound)
                        if (Number(price) > 0) {
                            await futuresApi.createPriceTriggeredOrder(settle, {
                                initial: {
                                    contract: `${symbol}_USDT`,
                                    size: 0,// 平仓
                                    price: "0",// 止盈
                                    reduceOnly: true,
                                    tif: "ioc",
                                    close: true,
                                },
                                trigger: {
                                    strategyType: 0,
                                    priceType: 0,
                                    price: price,
                                    rule: direction === "buy" ? 1 : 2
                                },
                                orderType: direction === "buy" ? "close-long-position" : "close-short-position",
                            })
                        }
                    }
                }
                console.log("success")
            } else {
                console.log(userOptions.userId + "保证金不足")
            }
        }
    } catch (e) {
        console.log("下单出错", e)
    }
}