import BinanceFuturesTrade from "./BinanceFutures/BinanceFuturesTrade";
import {decrypt} from "./utils";
import {intersectionWith, isEmpty} from "lodash";
import {saveUserBalance} from "./saveUserBalance";

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
            filterTradeDate = intersectionWith(tradeData, currency, (a, b) => `${a.symbol}` === b)
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