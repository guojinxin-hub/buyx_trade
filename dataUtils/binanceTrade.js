import BinanceFuturesTrade from "./BinanceFutures/BinanceFuturesTrade";
import {decrypt} from "./utils";
import {intersectionWith, isEmpty} from "lodash";
import {saveUserBalance} from "./saveUserBalance";
import {saveTradeRecord} from "./saveTradeRecord";
import {formatPrice} from "./formatPrice";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";

export const binanceTrade = async ({tradeData, userOptions}) => {
    try {
        // 首先获取到当前可支持的币种信息
        const {apiKey, apiSecret, isTestOption, currency, isActive} = userOptions
        const trader = new BinanceFuturesTrade(decrypt(apiKey), decrypt(apiSecret), isTestOption);
        // 获取所有币种信息
        let futureContractData = []
        const symbols = await trader.getSymbolInfo()
        let filterTradeDate = null
        if (!isEmpty(currency)) {
            filterTradeDate = intersectionWith(tradeData, currency, (a, b) => `${a.symbol}_USDT` === b)
        } else {
            filterTradeDate = tradeData
        }
        for (const tradeItem of filterTradeDate) {
            const symbolInfo = symbols.find(s => s.symbol === `${tradeItem.symbol}USDT`);
            if (symbolInfo) {
                futureContractData.push({
                    ...tradeItem,
                    symbolInfo
                })
            }
        }
        if (isActive) {
            const {direction, insurance, maxVolume, leverage, stopLoss, takeProfit} = userOptions
            const accountInfo = await trader.checkUserAccount();
            const {availableBalance, totalUnrealizedProfit, totalWalletBalance} = accountInfo
            const accountFunds = {
                total: totalWalletBalance,
                unrealisedPnl: totalUnrealizedProfit,
                available: availableBalance
            }
            await saveUserBalance(userOptions.userId, accountFunds)
            for (const item of futureContractData) {
                if (direction === 'all' || direction === item.direction) {
                    // 执行交易
                    const result = await trader.executeTrade({
                        symbol: `${item.symbol}USDT`,
                        usdtAmount: Number(maxVolume),
                        direction: item.direction === "buy" ? 'LONG' : "SHORT",
                        leverage: Number(leverage),
                        minMargin: Number(insurance),
                        takeProfitPercent: Number(takeProfit), // 止盈
                        stopLossPercent: Number(stopLoss),// 止损
                        symbolInfo: item.symbolInfo,
                    });
                    console.log('交易结果:', result);
                    
                    // 保存交易记录
                    if (result.success && result.order && result.order.orderId) {
                        try {
                            await saveTradeRecord(userOptions.userId, {
                                symbol: `${item.symbol}`,
                                price: String(result.filledPrice),
                                size: String(result.filledQuantity),
                                direction: item.direction,
                                exchange: 'binance',
                                orderId: result.order.orderId.toString(),
                                leverage: String(leverage),
                                status: 'pending'  // 先设为待处理状态
                            });
                            
                            console.log(`交易记录保存成功: ${result.order.orderId}`);
                        } catch (error) {
                            console.error(`交易记录保存失败: ${error.message}`);
                            // 继续执行，不因记录保存失败而中断交易流程
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('交易失败:', error);
    }
}

export const updateProtectionStopLoss = async (req, res) => {
    try {
        const { userOptions, symbol, direction, protectionPrice } = req.body;
        
        // 1. 初始化 API 客户端
        const {apiKey, apiSecret, isTestOption} = userOptions
        const trader = new BinanceFuturesTrade(decrypt(apiKey), decrypt(apiSecret), isTestOption);
        
        // 2. 获取合约详细信息
        const symbols = await trader.getSymbolInfo();
        const symbolInfo = symbols.find(s => s.symbol === `${symbol}USDT`);
        
        if (!symbolInfo) {
            return res.status(400).json({success: false, message: '合约不存在'});
        }
        
        // 3. 格式化保护止损价格
        const priceStep = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize;
        const formattedPrice = formatPrice(protectionPrice.toString(), Number(priceStep));
        
        if (Number(formattedPrice) > 0) {
            // 4. 清除该合约所有的条件单，包括止损和止盈
            try {
                // 先尝试清除所有类型的条件单
                await trader.cancelAllOrders(`${symbol}USDT`);
                // 增加等待时间，确保币安API有足够的时间处理清除操作
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (e) {
                console.log("清除旧条件单失败", e);
            }
            
            // 5. 创建新的保护止损条件单
            const closeSide = direction === "buy" ? 'SELL' : "BUY";
            
            try {
                await trader.client.placeAlgoOrder(`${symbol}USDT`, {
                    side: closeSide,
                    type: 'STOP_MARKET', // 使用市价止损
                    triggerPrice: Number(formattedPrice),
                    closePosition: 'true', // 平仓
                });
            } catch (e) {
                console.log("创建保护止损单失败", e);
                // 检查是否是因为重复订单错误
                if (e.message.includes("An open stop or take profit order with GTE and closePosition in the direction is existing")) {
                    // 再次尝试清除所有订单
                    try {
                        await trader.cancelAllOrders(`${symbol}USDT`);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        // 再次尝试创建订单
                        await trader.client.placeAlgoOrder(`${symbol}USDT`, {
                            side: closeSide,
                            type: 'STOP_MARKET', // 使用市价止损
                            triggerPrice: Number(formattedPrice),
                            closePosition: 'true', // 平仓
                        });
                    } catch (retryError) {
                        console.log("重试创建保护止损单失败", retryError);
                        throw retryError;
                    }
                } else {
                    throw e;
                }
            }
            
            console.log(`用户 ${userOptions.userId} 的 ${symbol} 保护止损单已更新，价格为 ${formattedPrice}`);
            return res.status(200).json({success: true, message: '保护止损单更新成功'});
        }

        return res.status(200).json({success: false, message: '保护止损价格无效'});
    } catch (e) {
        console.log("更新保护止损单出错", e);
        return res.status(500).json({success: false, message: '更新保护止损单出错', error: e.message});
    }
}

/**
 * 获取 Binance 交易所的持仓信息
 * @param {Object} userOptions - 用户配置
 * @returns {Promise<Array>} 持仓信息列表
 */
export const getBinancePositions = async (userOptions) => {
    try {
        console.log(`获取用户 ${userOptions.userId} 的 Binance 交易所持仓信息`);
        
        // 1. 初始化 API 客户端
        const {apiKey, apiSecret, isTestOption} = userOptions
        const trader = new BinanceFuturesTrade(decrypt(apiKey), decrypt(apiSecret), isTestOption);
        
        // 2. 获取所有持仓
        const accountInfo = await trader.client.getAccountInfo();
        console.log(`获取到账户信息:`, JSON.stringify(accountInfo, null, 2));
        
        // 检查 positions 字段
        if (!accountInfo.positions || !Array.isArray(accountInfo.positions)) {
            console.error(`账户信息中没有有效的 positions 字段`);
            return [];
        }
        
        const positions = accountInfo.positions;
        console.log(`获取到 ${positions.length} 个持仓记录`);
        
        // 3. 处理持仓数据
        const positionList = positions.filter(position => {
            // 只返回有持仓的记录
            const positionAmt = Number(position.positionAmt);
            const hasPosition = positionAmt !== 0;
            console.log(`检查持仓 ${position.symbol}: positionAmt=${position.positionAmt}, hasPosition=${hasPosition}`);
            return hasPosition;
        }).map(position => {
            console.log(`处理持仓 ${position.symbol}:`, JSON.stringify(position, null, 2));
            
            // 提取交易对符号（去除 USDT 后缀）
            const symbol = position.symbol.replace('USDT', '');
            
            // 确定交易方向
            const direction = Number(position.positionAmt) > 0 ? 'buy' : 'sell';
            
            return {
                symbol,
                direction,
                price: position.entryPrice || position.avgPrice, // 平均入场价格
                size: Math.abs(Number(position.positionAmt)), // 持仓数量（取绝对值）
                exchange: 'binance',
                unrealisedPnl: position.unRealizedProfit || position.unrealizedProfit || position.pnl, // 未实现盈亏（尝试不同字段名）
                leverage: position.leverage, // 杠杆
                markPrice: position.markPrice || position.markPrice // 标记价格
            };
        });
        
        console.log(`用户 ${userOptions.userId} 的 Binance 交易所持仓信息:`, positionList);
        return positionList;
    } catch (error) {
        console.error(`获取 Binance 交易所持仓信息出错:`, error);
        return [];
    }
};