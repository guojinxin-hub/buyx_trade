import {intersectionWith, isEmpty} from "lodash";
import BitgetFuturesTrade from "./BitgetFutures/BitgetFuturesTrade";
import BitgetLeaderTrade from "./BitgetFutures/BitgetLeaderTrade";
import {decrypt} from "./utils";
import {saveUserBalance} from "./saveUserBalance";

export const bitgetTrade = async ({tradeData, userOptions}) => {
    console.log("Bitget交易启动");
    try {
        const {apiKey, apiSecret, passphrase, isTestOption = false, currency, isActive} = userOptions;
        const trader = new BitgetFuturesTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase,
            isSimulated: isTestOption
        });

        let filterTradeData;
        if (!isEmpty(currency)) {
            filterTradeData = intersectionWith(tradeData, currency, (a, b) => {
                // 兼容不同存储格式：BTCUSDT_UMCBL 或 BTCUSDT
                const v1 = `${a.symbol}USDT_UMCBL`;
                const v2 = `${a.symbol}USDT`;
                return v1 === b || v2 === b;
            });
        } else {
            filterTradeData = tradeData;
        }

        const futureContractData = [];
        let symbols = null;
        try {
            symbols = await trader.getSymbolsInfo();
        } catch (e) {
            // contracts 拉取失败：先不影响下单流程
            console.log('Bitget contracts 拉取失败，跳过 symbolInfo：', e.message);
        }
        for (const tradeItem of filterTradeData) {
            if (symbols && Array.isArray(symbols) && symbols.length > 0) {
                const expectedV1 = `${tradeItem.symbol}USDT_UMCBL`;
                const expectedV2 = `${tradeItem.symbol}USDT`;
                const symbolInfo = symbols.find((s) => {
                    const sym = s?.symbol;
                    if (!sym) return false;
                    if (sym === expectedV1) return true;
                    if (sym === expectedV2) return true;
                    if (sym.replace('_UMCBL', '') === expectedV2) return true;
                    return false;
                });

                futureContractData.push({
                    ...tradeItem,
                    symbolInfo: symbolInfo || null
                });
            } else {
                // 没拿到 contracts 详情：symbolInfo 置空，数量将使用通用精度计算
                futureContractData.push({
                    ...tradeItem,
                    symbolInfo: null
                });
            }
        }

        if (isActive) {
            const {direction, insurance, maxVolume, leverage, stopLoss, takeProfit} = userOptions;
            const accountBalance = await trader.getAccountInfo();
            console.log("accountBalance",accountBalance)
            await saveUserBalance(userOptions.userId, accountBalance.balance);

            for (const item of futureContractData) {
                const result = await trader.executeTrade({
                    symbol: `${item.symbol}`,
                    usdtAmount: Number(maxVolume),
                    direction: item.direction,
                    leverage: Number(leverage),
                    minMargin: Number(insurance),
                    takeProfitPercent: Number(takeProfit),
                    stopLossPercent: Number(stopLoss),
                    symbolInfo: item.symbolInfo,
                    settingDirection: direction
                });
                console.log('Bitget 交易结果:', result);
                await new Promise((r) => setTimeout(r, 120));
            }
        }
    } catch (error) {
        console.error('Bitget交易失败:', error);
    }
};

export const getBitgetPositions = async (userOptions) => {
    try {
        const {apiKey, apiSecret, passphrase, isTestOption = false} = userOptions;
        const trader = new BitgetFuturesTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase,
            isSimulated: isTestOption
        });

        const positions = await trader.getPositions();
        if (!positions || !Array.isArray(positions)) {
            return [];
        }

        return positions
            .filter((position) => Math.abs(Number(position.total || 0)) > 0)
            .map((position) => {
                const symbol = (position.symbol || '').replace('USDT_UMCBL', '');
                const direction = position.holdSide === 'long' ? 'buy' : 'sell';
                const entryPrice = Number(position.averageOpenPrice || 0);
                const markPrice = Number(position.markPrice || 0);
                const pnl = Number(position.unrealizedPL || 0);
                const margin = Number(position.margin || 0);
                const profitPercentage = margin > 0 ? (pnl / margin) * 100 : 0;

                return {
                    symbol,
                    direction,
                    entryPrice: position.averageOpenPrice,
                    avgPrice: position.averageOpenPrice,
                    markPrice: position.markPrice,
                    lastPrice: position.markPrice,
                    currentPrice: position.markPrice,
                    size: Number(position.total || 0),
                    exchange: 'bitget',
                    unrealisedPnl: profitPercentage
                };
            });
    } catch (error) {
        console.error('获取 Bitget 交易所持仓信息出错:', error.message);
        return [];
    }
};


export const bitgetLeaderTrade = async ({tradeData, userOptions}) => {
    console.log("Bitget带单交易启动");
    try {
        const {apiKey, apiSecret, passphrase, isTestOption = false, currency, isActive, traderId} = userOptions;
        const trader = new BitgetLeaderTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase,
            isSimulated: isTestOption,
            traderId
        });

        // 获取交易员信息
        try {
            const traderInfo = await trader.getTraderInfo();
            console.log('Bitget 交易员信息:', traderInfo);
        } catch (error) {
            console.warn('获取交易员信息失败:', error.message);
        }

        // 获取交易员订单跟踪
        try {
            const ordersTrack = await trader.getTraderOrdersTrack(1, 20);
            console.log('Bitget 交易员订单跟踪:', ordersTrack);
        } catch (error) {
            console.warn('获取交易员订单跟踪失败:', error.message);
        }

        let filterTradeData;
        if (!isEmpty(currency)) {
            filterTradeData = intersectionWith(tradeData, currency, (a, b) => {
                // 兼容不同存储格式：BTCUSDT_UMCBL 或 BTCUSDT
                const v1 = `${a.symbol}USDT_UMCBL`;
                const v2 = `${a.symbol}USDT`;
                return v1 === b || v2 === b;
            });
        } else {
            filterTradeData = tradeData;
        }

        const futureContractData = [];
        let symbols = null;
        try {
            symbols = await trader.getSymbolsInfo();
        } catch (e) {
            // contracts 拉取失败：先不影响下单流程
            console.log('Bitget contracts 拉取失败，跳过 symbolInfo：', e.message);
        }
        for (const tradeItem of filterTradeData) {
            if (symbols && Array.isArray(symbols) && symbols.length > 0) {
                const expectedV1 = `${tradeItem.symbol}USDT_UMCBL`;
                const expectedV2 = `${tradeItem.symbol}USDT`;
                const symbolInfo = symbols.find((s) => {
                    const sym = s?.symbol;
                    if (!sym) return false;
                    if (sym === expectedV1) return true;
                    if (sym === expectedV2) return true;
                    if (sym.replace('_UMCBL', '') === expectedV2) return true;
                    return false;
                });

                futureContractData.push({
                    ...tradeItem,
                    symbolInfo: symbolInfo || null
                });
            } else {
                // 没拿到 contracts 详情：symbolInfo 置空，数量将使用通用精度计算
                futureContractData.push({
                    ...tradeItem,
                    symbolInfo: null
                });
            }
        }

        if (isActive) {
            const {direction, insurance, maxVolume, leverage, stopLoss, takeProfit} = userOptions;
            const accountBalance = await trader.getAccountInfo();
            console.log("accountBalance",accountBalance)
            await saveUserBalance(userOptions.userId, accountBalance.balance);

            for (const item of futureContractData) {
                const result = await trader.executeTrade({
                    symbol: `${item.symbol}`,
                    usdtAmount: Number(maxVolume),
                    direction: item.direction,
                    leverage: Number(leverage),
                    minMargin: Number(insurance),
                    takeProfitPercent: Number(takeProfit),
                    stopLossPercent: Number(stopLoss),
                    symbolInfo: item.symbolInfo,
                    settingDirection: direction
                });
                console.log('Bitget 带单交易结果:', result);
                await new Promise((r) => setTimeout(r, 500));
            }
        }
    } catch (error) {
        console.error('Bitget带单交易失败:', error);
    }
};

export const getBitgetLeaderPositions = async (userOptions) => {
    try {
        const {apiKey, apiSecret, passphrase, isTestOption = false, traderId} = userOptions;
        const trader = new BitgetLeaderTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase,
            isSimulated: isTestOption,
            traderId
        });

        // 获取交易员订单跟踪信息
        try {
            const ordersTrack = await trader.getTraderOrdersTrack(1, 20);
            console.log('Bitget 交易员订单跟踪:', ordersTrack);
        } catch (error) {
            console.warn('获取交易员订单跟踪失败:', error.message);
        }

        // 获取持仓信息
        const positions = await trader.getPositions();
        if (!positions || !Array.isArray(positions)) {
            return [];
        }

        return positions
            .filter((position) => Math.abs(Number(position.total || 0)) > 0)
            .map((position) => {
                const symbol = (position.symbol || '').replace('USDT_UMCBL', '');
                const direction = position.holdSide === 'long' ? 'buy' : 'sell';
                const entryPrice = Number(position.averageOpenPrice || 0);
                const markPrice = Number(position.markPrice || 0);
                const pnl = Number(position.unrealizedPL || 0);
                const margin = Number(position.margin || 0);
                const profitPercentage = margin > 0 ? (pnl / margin) * 100 : 0;

                return {
                    symbol,
                    direction,
                    entryPrice: position.averageOpenPrice,
                    avgPrice: position.averageOpenPrice,
                    markPrice: position.markPrice,
                    lastPrice: position.markPrice,
                    currentPrice: position.markPrice,
                    size: Number(position.total || 0),
                    exchange: 'bitget_leader',
                    unrealisedPnl: profitPercentage
                };
            });
    } catch (error) {
        console.error('获取 Bitget 带单持仓信息出错:', error.message);
        return [];
    }
};
