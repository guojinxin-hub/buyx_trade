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
                    settingDirection: direction,
                });
                console.log('交易结果:', result);
            }
        }
    } catch (error) {
        console.error('OKX交易失败:', error);
    }
}

/**
 * 获取 OKX 交易所的持仓信息
 * @param {Object} userOptions - 用户配置
 * @returns {Promise<Array>} 持仓信息列表
 */
// 网络请求重试函数
const retryRequest = async (fn, retries = 3, delay = 2000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`请求失败，第${i + 1}次尝试:`, error.message);
            if (i === retries - 1) {
                // 最后一次尝试失败，抛出错误
                throw error;
            }
            // 等待一段时间再重试
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

export const getOKXPositions = async (userOptions) => {
    try {
        const { apiKey, apiSecret, passphrase, isTestOption } = userOptions;
        const trader = new OKXFuturesTrader({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase: passphrase,
            isSimulated: isTestOption
        });

        // 使用重试机制获取持仓信息
        const positions = await retryRequest(() => trader.getPositions(), 3, 3000);

        // 添加延迟，避免API调用过于频繁
        await new Promise(resolve => setTimeout(resolve, 500));

        if (!positions || !Array.isArray(positions)) {
            return [];
        }

        const positionsWithPrice = [];
        
        for (const position of positions) {
            if (parseFloat(position.pos) !== 0) {
                const posAmt = parseFloat(position.pos);
                const direction = posAmt > 0 ? 'buy' : 'sell';

                // 提取交易对符号
                const instId = position.instId;
                const symbol = instId.replace('-USDT-SWAP', '');

                // 使用实际的未实现盈亏和初始保证金计算真实收益率
                const entryPrice = parseFloat(position.avgPx) || 0;
                const markPrice = parseFloat(position.markPx) || 0;
                const leverage = parseFloat(position.lever) || 1;
                const unrealizedPnl = parseFloat(position.upl) || 0;
                const positionInitialMargin = parseFloat(position.margin) || 0;

                let profitPercentage = 0;

                // 如果有实际盈亏数据，则使用保证金计算收益率
                if (positionInitialMargin > 0) {
                    // 收益率 = (未实现盈亏 / 仓位保证金) * 100%
                    profitPercentage = (unrealizedPnl / positionInitialMargin) * 100;
                } else if (entryPrice > 0 && markPrice > 0) {
                    // 备用计算方式：使用价格变动计算
                    const priceDiff = posAmt > 0
                        ? (markPrice - entryPrice) / entryPrice  // 做多
                        : (entryPrice - markPrice) / entryPrice; // 做空
                    profitPercentage = priceDiff * 100;
                }

                positionsWithPrice.push({
                    symbol: symbol,
                    direction: direction,
                    entryPrice: position.avgPx,
                    avgPrice: position.avgPx,
                    markPrice: position.markPx,
                    lastPrice: position.last,
                    currentPrice: position.last,
                    size: posAmt,
                    exchange: 'okx',
                    unrealisedPnl: profitPercentage // 返回计算后的收益率百分比
                });
            }
        }

        return positionsWithPrice;
    } catch (error) {
        console.error('获取 OKX 交易所持仓信息出错:', error.message);
        return [];
    }
};
