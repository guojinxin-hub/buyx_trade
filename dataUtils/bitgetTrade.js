import {intersectionWith, isEmpty} from "lodash";
import BitgetFuturesTrade from "./BitgetFutures/BitgetFuturesTrade";
import BitgetLeaderTrade from "./BitgetFutures/BitgetLeaderTrade";
import {decrypt} from "./utils";
import {saveUserBalance} from "./saveUserBalance";
import { saveTradeRecord } from "./saveTradeRecord";

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

            // 获取当前持仓并构建映射 {symbol: direction}
            const positions = await trader.getPositions();
            const positionMap = {};
            if (positions && Array.isArray(positions)) {
                for (const pos of positions) {
                    const total = Number(pos.total || 0);
                    if (Math.abs(total) > 0) {
                        const sym = (pos.symbol || '').replace('USDT_UMCBL', '');
                        positionMap[sym] = pos.holdSide === 'long' ? 'buy' : 'sell';
                    }
                }
            }

            for (const item of futureContractData) {
                // 检查同方向是否已有持仓，有则跳过不加仓
                if (positionMap[item.symbol] && positionMap[item.symbol] === item.direction) {
                    console.log(`Bitget ${item.symbol} 同方向已有持仓，跳过加仓`);
                    continue;
                }
                
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

                // 保存交易记录
                if (result.success && result.order) {
                    try {
                        await saveTradeRecord(userOptions.userId, {
                            symbol: item.symbol,
                            price: result.order.price || '0',
                            size: result.order.size || '0',
                            direction: item.direction,
                            exchange: 'bitget',
                            orderId: result.order.orderId || result.order.id || '',
                            leverage: String(leverage),
                            status: 'pending'
                        });
                        console.log(`交易记录保存成功: ${result.order.orderId || result.order.id}`);
                    } catch (error) {
                        console.error(`交易记录保存失败: ${error.message}`);
                    }
                }
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


/**
 * Bitget带单交易函数
 * 用于执行Bitget带单交易相关的操作
 * 
 * @param {Object} params - 参数对象
 * @param {Array} params.tradeData - 交易数据数组，包含symbol和direction
 * @param {Object} params.userOptions - 用户配置对象
 * @param {string} params.userOptions.apiKey - API密钥
 * @param {string} params.userOptions.apiSecret - API密钥
 * @param {string} params.userOptions.passphrase - 密码短语
 * @param {boolean} params.userOptions.isTestOption - 是否测试模式
 * @param {Array} params.userOptions.currency - 货币过滤列表
 * @param {boolean} params.userOptions.isActive - 是否激活交易
 * @param {string} params.userOptions.direction - 交易方向过滤(all/buy/sell)
 * @param {number} params.userOptions.insurance - 最小保证金
 * @param {number} params.userOptions.maxVolume - 最大交易金额
 * @param {number} params.userOptions.leverage - 杠杆倍数
 * @param {number} params.userOptions.stopLoss - 止损百分比
 * @param {number} params.userOptions.takeProfit - 止盈百分比
 * @returns {Promise<void>}
 */
export const bitgetLeaderTrade = async ({tradeData, userOptions}) => {
    console.log("Bitget带单交易启动");
    try {
        // 步骤1: 解析用户配置
        const {apiKey, apiSecret, passphrase, isTestOption = false, currency, isActive} = userOptions;

        // 步骤2: 创建Bitget带单交易实例
        // 注意: 带单交易不需要traderId参数，直接使用自己的API密钥进行交易
        const trader = new BitgetLeaderTrade({
            apiKey: decrypt(apiKey),
            secretKey: decrypt(apiSecret),
            passphrase,
            isSimulated: isTestOption
        });

        // 步骤3: 根据货币过滤交易数据
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

        // 步骤4: 如果激活交易，执行下单操作
        if (isActive) {
            // 获取用户配置的交易参数
            const {direction, maxVolume, leverage, stopLoss, takeProfit} = userOptions;

            // 获取当前持仓并构建映射 {symbol: direction}
            const positions = await trader.getPositions();
            const positionMap = {};
            if (positions && Array.isArray(positions)) {
                for (const pos of positions) {
                    const total = Number(pos.total || 0);
                    if (Math.abs(total) > 0) {
                        const sym = (pos.symbol || '').replace('USDT_UMCBL', '');
                        positionMap[sym] = pos.holdSide === 'long' ? 'buy' : 'sell';
                    }
                }
            }

            // 遍历每个交易项并执行交易
            for (const item of filterTradeData) {
                // 检查同方向是否已有持仓，有则跳过不加仓
                if (positionMap[item.symbol] && positionMap[item.symbol] === item.direction) {
                    console.log(`Bitget带单 ${item.symbol} 同方向已有持仓，跳过加仓`);
                    continue;
                }
                
                // 调用executeTrade方法执行带单交易
                // 参数说明:
                // - symbol: 交易对符号 (如: ETH)
                // - usdtAmount: 交易金额 (USDT)
                // - direction: 交易方向 (buy/sell)，来自tradeData
                // - leverage: 杠杆倍数
                // - takeProfitPercent: 止盈百分比
                // - stopLossPercent: 止损百分比
                // - settingDirection: 设置的方向过滤 (all/buy/sell)，来自userOptions
                const result = await trader.executeTrade({
                    symbol: `${item.symbol}`,
                    usdtAmount: Number(maxVolume),
                    direction: item.direction,  // 使用tradeData中的direction
                    leverage: Number(leverage),
                    takeProfitPercent: Number(takeProfit),
                    stopLossPercent: Number(stopLoss),
                    settingDirection: direction  // 使用userOptions中的direction进行过滤
                });
                console.log('Bitget 带单交易结果:', result);

                // 保存交易记录
                if (result.success && result.order) {
                    try {
                        await saveTradeRecord(userOptions.userId, {
                            symbol: item.symbol,
                            price: result.order.price || '0',
                            size: result.order.size || '0',
                            direction: item.direction,
                            exchange: 'bitget_leader',
                            orderId: result.order.orderId || result.order.id || '',
                            leverage: String(leverage),
                            status: 'pending'
                        });
                        console.log(`交易记录保存成功: ${result.order.orderId || result.order.id}`);
                    } catch (error) {
                        console.error(`交易记录保存失败: ${error.message}`);
                    }
                }

                // 延迟500ms，避免请求过于频繁
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
