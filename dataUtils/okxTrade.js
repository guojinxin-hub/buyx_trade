// 初始化交易器
import {intersectionWith, isEmpty} from "lodash";
import OKXFuturesTrader from "./OKXFutures/OKXFuturesTrade";
import {saveUserBalance} from "./saveUserBalance";
import {decrypt} from "./utils";

export const okxTrade = async ({tradeData, userOptions}) => {
    console.log("OKX交易启动")
    try {
        const {apiKey, apiSecret, passphrase, isTestOption = true, currency, isActive} = userOptions
        const trader = new OKXFuturesTrader({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase: passphrase,
            isSimulated: isTestOption // 使用模拟盘
        });

        let futureContractData = []
        const symbols = await trader.getSymbolsInfo()
        await new Promise(resolve => setTimeout(resolve, 100));
        let filterTradeDate = null
        if (!isEmpty(currency)) {
            filterTradeDate = intersectionWith(tradeData, currency, (a, b) => `${a.symbol}` === b)
        } else {
            filterTradeDate = tradeData
        }
        for (const tradeItem of filterTradeDate) {
            const symbolInfo = symbols.find(s => s.instId === `${tradeItem.symbol}-USDT-SWAP`);
            if (symbolInfo) {
                futureContractData.push({
                    ...tradeItem,
                    symbolInfo
                })
            }
        }
        if (isActive) {
            const {direction, insurance, maxVolume, leverage, stopLoss, takeProfit} = userOptions
            // 获取用户的账户余额
            const accountBalance = await trader.getAccountInfo()
            await new Promise(resolve => setTimeout(resolve, 100));
            await saveUserBalance(userOptions.userId, accountBalance.balance)
            // 修改持仓模式为单向持仓
            const positionMode = await trader.getPositionMode()
            if (positionMode.posMode !== 'net_mode') {
                await trader.setPositionMode()
            }
            for (const item of futureContractData) {
                if (direction === 'all' || direction === item.direction) {
                    // 执行交易
                    const result = await trader.executeTrade({
                        instId: `${item.symbol}-USDT-SWAP`, // 交易对
                        usdtAmount: Number(maxVolume), // 交易金额
                        direction: item.direction, // 方向: buy/sell
                        leverage: Number(leverage), // 杠杆倍数
                        minMargin: Number(insurance), // 最小保证金要求
                        takeProfitPercent: Number(takeProfit), // 止盈百分比
                        stopLossPercent: Number(stopLoss), // 止损百分比
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
