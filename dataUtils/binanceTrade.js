import BinanceFuturesTrade from "./BinanceFutures/BinanceFuturesTrade";
import {decrypt} from "./utils";
import {intersectionWith, isEmpty} from "lodash";
import {saveUserBalance} from "./saveUserBalance";
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
            // 4. 清除该合约旧的止损条件单，保留止盈条件单
            try {
                await trader.cancelOrders(`${symbol}USDT`, 'stop_loss');
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (e) {
                console.log("清除旧止损条件单失败", e);
            }
            
            // 5. 创建新的保护止损条件单
            const closeSide = direction === "buy" ? 'SELL' : "BUY";
            
            await trader.client.placeAlgoOrder(`${symbol}USDT`, {
                side: closeSide,
                type: 'STOP_MARKET', // 使用市价止损
                triggerPrice: Number(formattedPrice),
                closePosition: 'true', // 平仓
            });
            
            console.log(`用户 ${userOptions.userId} 的 ${symbol} 保护止损单已更新，价格为 ${formattedPrice}`);
            return res.status(200).json({success: true, message: '保护止损单更新成功'});
        }

        return res.status(200).json({success: false, message: '保护止损价格无效'});
    } catch (e) {
        console.log("更新保护止损单出错", e);
        return res.status(500).json({success: false, message: '更新保护止损单出错', error: e.message});
    }
}