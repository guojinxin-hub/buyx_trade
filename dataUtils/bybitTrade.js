import { intersectionWith, isEmpty } from "lodash";
import BybitFuturesTrader from "./BybitFutures/BybitFuturesTrade";
import { saveUserBalance } from "./saveUserBalance";
import { saveTradeRecord } from "./saveTradeRecord";
import { decrypt } from "./utils";

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
            
            // 获取当前持仓并构建映射 {symbol: direction}
            const positions = await trader.getPositions();
            await new Promise(resolve => setTimeout(resolve, 100));
            const positionMap = {};
            if (positions && Array.isArray(positions)) {
                for (const pos of positions) {
                    const posAmt = parseFloat(pos.pos);
                    if (Math.abs(posAmt) > 0) {
                        const sym = (pos.instId || '').replace('USDT', '');
                        positionMap[sym] = pos.side === 'Buy' ? 'buy' : 'sell';
                    }
                }
            }
            
            // 执行每个交易对的交易
            for (const item of futureContractData) {
                // 检查同方向是否已有持仓，有则跳过不加仓
                if (positionMap[item.symbol] && positionMap[item.symbol] === item.direction) {
                    console.log(`Bybit ${item.symbol} 同方向已有持仓，跳过加仓`);
                    continue;
                }
                
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

                // 保存交易记录
                if (result.success && result.order) {
                    try {
                        await saveTradeRecord(userOptions.userId, {
                            symbol: item.symbol,
                            price: result.order.price || '0',
                            size: result.order.qty || '0',
                            direction: item.direction,
                            exchange: 'bybit',
                            orderId: result.order.orderId || result.order.id || '',
                            leverage: String(leverage),
                            status: 'pending'
                        });
                        console.log(`交易记录保存成功: ${result.order.orderId || result.order.id}`);
                    } catch (error) {
                        console.error(`交易记录保存失败: ${error.message}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Bybit交易失败:', error);
    }
};

/**
 * 获取 Bybit 交易所的持仓信息
 * @param {Object} userOptions - 用户配置对象
 * @returns {Promise<Array>} 持仓信息列表
 */
export const getBybitPositions = async (userOptions) => {
    try {
        const { apiKey, apiSecret, isTestOption = true } = userOptions;
        const trader = new BybitFuturesTrader({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            isTestnet: isTestOption
        });

        // 获取所有持仓
        const positions = await trader.getPositions();

        if (!positions || !Array.isArray(positions)) {
            return [];
        }

        // 过滤出有持仓的仓位，并转换为统一格式
        return positions
            .filter(position => Math.abs(parseFloat(position.pos)) > 0)
            .map(position => {
                const symbol = (position.instId || '').replace('USDT', '');
                const direction = position.side === 'Buy' ? 'buy' : 'sell';
                const entryPrice = parseFloat(position.avgPx) || 0;
                const markPrice = parseFloat(position.markPx || position.last || 0);
                const pnl = parseFloat(position.upl) || 0;
                const margin = parseFloat(position.mgn) || 0;
                const profitPercentage = margin > 0 ? (pnl / margin) * 100 : 0;

                return {
                    symbol,
                    direction,
                    entryPrice,
                    avgPrice: entryPrice,
                    markPrice,
                    lastPrice: markPrice,
                    currentPrice: markPrice,
                    size: Math.abs(parseFloat(position.pos)),
                    exchange: 'bybit',
                    unrealisedPnl: profitPercentage,
                    absolutePnl: parseFloat(position.upl) || 0
                };
            });
    } catch (error) {
        console.error('获取 Bybit 交易所持仓信息出错:', error.message);
        return [];
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