import { intersectionWith, isEmpty } from "lodash";
import BybitFuturesTrader from "./BybitFutures/BybitFuturesTrade";
import { saveUserBalance } from "./saveUserBalance";
import {decrypt} from "./utils";

/**
 * Bybit 交易执行函数
 */
export const bybitTrade = async ({ tradeData, userOptions }) => {
    console.log("Bybit交易启动");

    try {
        const {
            apiKey,
            apiSecret,
            isTestOption = true,
            currency,
            isActive
        } = userOptions;

        const trader = new BybitFuturesTrader({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            isTestnet: isTestOption
        });

        // 获取所有交易对信息
        let futureContractData = [];
        const symbols = await trader.getSymbolsInfo();
        await new Promise(resolve => setTimeout(resolve, 100));

        // 过滤需要交易的币种
        let filterTradeDate = null;
        if (!isEmpty(currency)) {
            filterTradeDate = intersectionWith(tradeData, currency, (a, b) => `${a.symbol}` === b);
        } else {
            filterTradeDate = tradeData;
        }

        // 匹配交易对信息
        for (const tradeItem of filterTradeDate) {
            const symbolInfo = symbols.find(s => s.symbol === `${tradeItem.symbol}USDT`);
            if (symbolInfo) {
                futureContractData.push({
                    ...tradeItem,
                    symbolInfo
                });
            }
        }

        if (isActive) {
            const { direction, insurance, maxVolume, leverage, stopLoss, takeProfit } = userOptions;

            // 获取用户的账户余额
            const accountBalance = await trader.getAccountInfo();
            await new Promise(resolve => setTimeout(resolve, 100));
            await saveUserBalance(userOptions.userId, accountBalance.balance);

            await trader.setPositionMode(0);

            // 执行每个交易对的交易
            for (const item of futureContractData) {
                const result = await trader.executeTrade({
                    symbol: `${item.symbol}USDT`,
                    usdtAmount: Number(maxVolume),
                    direction: item.direction === 'buy' ? 'Buy' : 'Sell',
                    leverage: Number(leverage),
                    minMargin: Number(insurance),
                    takeProfitPercent: Number(takeProfit),
                    stopLossPercent: Number(stopLoss),
                    symbolInfo: item.symbolInfo,
                    settingDirection: direction === 'all' ? 'all' : (direction === 'buy' ? 'Buy' : 'Sell'),
                });
                console.log('交易结果:', result);
            }
        }
    } catch (error) {
        console.error('Bybit交易失败:', error);
    }
};

/**
 * 网络请求重试函数
 */
const retryRequest = async (fn, retries = 3, delay = 2000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`请求失败，第${i + 1}次尝试:`, error.message);
            if (i === retries - 1) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};