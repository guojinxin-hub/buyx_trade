import { UserTradeOptionsModel } from "buydip_scheme";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { updateProtectionStopLoss, getUserPositions } from "./apiTrade.js";

/**
 * 日志记录工具
 */
const logger = {
    info: (...args) => {
        console.log('[INFO]', new Date().toISOString(), ...args);
    },
    warn: (...args) => {
        console.warn('[WARN]', new Date().toISOString(), ...args);
    },
    error: (...args) => {
        console.error('[ERROR]', new Date().toISOString(), ...args);
    }
};

/**
 * 通用的API调用重试函数
 * @param {Function} fn - 要执行的异步函数
 * @param {number} maxRetries - 最大重试次数，默认3次
 * @param {number} delay - 重试间隔，默认1000ms
 * @returns {Promise<any>} - 函数执行结果
 */
async function retryAsync(fn, maxRetries = 3, delay = 1000) {
    let retries = 0;
    while (true) {
        try {
            return await fn();
        } catch (error) {
            retries++;
            if (retries > maxRetries) {
                logger.error(`重试失败，已达到最大重试次数 ${maxRetries}`);
                throw error;
            }
            logger.warn(`操作失败，${delay}ms后重试 (${retries}/${maxRetries})`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * 计算盈利比例
 * @param {number} currentPrice - 当前价格
 * @param {number} entryPrice - 入场价格
 * @param {string} direction - 交易方向
 * @returns {number} 盈利比例（百分比）
 */
const calculateProfitPercentage = (currentPrice, entryPrice, direction) => {
    // 检查价格是否有效
    if (!isValidPrice(currentPrice) || !isValidPrice(entryPrice)) {
        return 0;
    }
    
    currentPrice = parseFloat(currentPrice);
    entryPrice = parseFloat(entryPrice);
    
    // 避免除以零
    if (entryPrice === 0) {
        return 0;
    }
    
    if (direction === 'buy') {
        return ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
        return ((entryPrice - currentPrice) / entryPrice) * 100;
    }
};

/**
 * 计算保护止损价格
 * @param {number} entryPrice - 入场价格
 * @param {string} direction - 交易方向
 * @param {Object} userOption - 用户配置
 * @returns {number} 保护止损价格
 */
const calculateProtectionPrice = (entryPrice, direction, userOption) => {
    // 从用户配置中获取保护止损价格比例，默认为2%
    const protectionPercentage =  2;

    if (direction === 'buy') {
        // 买入单：入场价格*(1-保护比例)，例如100 * 0.98 = 98
        // 当价格下跌时触发止损，保护盈利
        return entryPrice * (1 - protectionPercentage / 100);
    } else {
        // 卖出单：入场价格*(1+保护比例)，例如100 * 1.02 = 102
        // 当价格上涨时触发止损，保护盈利
        return entryPrice * (1 + protectionPercentage / 100);
    }
};

/**
 * 检查价格是否有效
 * @param {string|number} price - 价格
 * @returns {boolean} 是否有效
 */
const isValidPrice = (price) => {
    if (!price) return false;
    const priceNum = parseFloat(price);
    return !isNaN(priceNum) && priceNum > 0;
};

/**
 * 处理单个用户的盈利保护
 * @param {Object} userOption - 用户配置
 * @returns {Promise<Object>} 处理结果
 */
const handleUserProfitProtection = async (userOption) => {
    try {
        // 验证用户配置
        if (!userOption || !userOption.userId) {
            logger.error('无效的用户配置');
            return { success: false, message: '无效的用户配置' };
        }

        logger.info(`开始处理用户 ${userOption.userId} 的盈利保护`);

        // 从 API 获取用户的最新持仓信息，使用重试机制
        const positions = await retryAsync(
            () => getUserPositions(userOption),
            2, // 最大重试2次
            1000 // 每次重试间隔1000ms
        );

        // 获取用户的持仓币种列表
        const positionSymbols = positions.map(p => p.symbol.toUpperCase());
        logger.info(`用户 ${userOption.userId} 的持仓币种:`, positionSymbols);

        // 查询用户的 pending 状态订单
        const pendingOrders = await retryAsync(
            () => TradeRecordModel.find({
                userId: userOption.userId,
                status: 'pending'
            }),
            2,
            1000
        );

        logger.info(`用户 ${userOption.userId} 有 ${pendingOrders.length} 个 pending 状态的订单`);

        // 检查并更新不在持仓中的订单状态
        for (const order of pendingOrders) {
            const orderSymbol = order.symbol.toUpperCase();
            if (!positionSymbols.includes(orderSymbol)) {
                logger.info(`用户 ${userOption.userId} 的 ${orderSymbol} 订单不在持仓中，将状态改为 cancelled`);
                await retryAsync(
                    () => TradeRecordModel.findByIdAndUpdate(order._id, {
                        status: 'cancelled'
                    }),
                    2,
                    1000
                );
            }
        }

        if (positions.length === 0) {
            logger.info(`用户 ${userOption.userId} 没有持仓`);
            return { success: true, message: '没有持仓', updatedCount: 0 };
        }

        logger.info(`用户 ${userOption.userId} 有 ${positions.length} 个持仓`);
        
        // 获取用户在 TradeRecordModel 中的币种列表
        const tradeRecordSymbols = pendingOrders.map(o => o.symbol.toUpperCase());
        logger.info(`用户 ${userOption.userId} 在 TradeRecordModel 中的币种:`, tradeRecordSymbols);

        // 从用户配置中获取盈利保护触发阈值，默认为5%
        const profitProtectionThreshold = 6;

        // 处理结果
        const result = {
            success: true,
            message: '盈利保护处理完成',
            updatedCount: 0,
            symbols: []
        };

        // 对每个持仓处理盈利保护
        for (const position of positions) {
            const { symbol, direction, exchange = 'binance' } = position;
            
            const entryPrice = position.entryPrice || position.price || position.avgPrice;
            const currentPrice = position.currentPrice || position.markPrice || position.lastPrice;
            const profitData = position.profitPercentage || position.unrealisedPnl || position.pnl;
            
            if (!symbol || !direction) {
                logger.warn(`持仓数据缺少基本信息，跳过: ${JSON.stringify(position)}`);
                continue;
            }
            
            // 检查该币种是否在 TradeRecordModel 中
            const positionSymbolUpper = symbol.toUpperCase();
            if (!tradeRecordSymbols.includes(positionSymbolUpper)) {
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 不在 TradeRecordModel 中，跳过盈利保护`);
                continue;
            }

            let actualProfitPercentage = 0;
            let hasValidProfit = false;
            let calculatedEntryPrice = entryPrice;
            
            if (profitData !== undefined) {
                const profitValue = parseFloat(profitData);
                
                if (!isNaN(profitValue)) {
                    if (profitValue > 0) {
                        hasValidProfit = true;
                        
                        // 根据交易所类型判断 profitData 是百分比还是金额
                        if (exchange === 'binance') {
                            // Binance: profitData 是金额，需要重新计算百分比
                            if (isValidPrice(currentPrice) && isValidPrice(entryPrice)) {
                                actualProfitPercentage = calculateProfitPercentage(currentPrice, entryPrice, direction);
                                if (actualProfitPercentage > 0) {
                                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓盈利 ${actualProfitPercentage.toFixed(2)}% (从金额计算得到)`);
                                } else {
                                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓未盈利，跳过`);
                                    continue;
                                }
                            } else {
                                logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓数据不足，跳过`);
                                continue;
                            }
                        } else {
                            // 其他交易所: profitData 是百分比
                            actualProfitPercentage = profitValue;
                            logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓盈利 ${actualProfitPercentage.toFixed(2)}% (从unrealisedPnl获取)`);
                        }
                    } else {
                        logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓亏损 ${Math.abs(profitValue).toFixed(2)}，跳过`);
                        continue;
                    }
                }
            } else if (isValidPrice(currentPrice) && isValidPrice(entryPrice)) {
                actualProfitPercentage = calculateProfitPercentage(currentPrice, entryPrice, direction);
                if (actualProfitPercentage > 0) {
                    hasValidProfit = true;
                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓盈利 ${actualProfitPercentage.toFixed(2)}% (计算得到)`);
                } else {
                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓未盈利，跳过`);
                    continue;
                }
            }

            if (!hasValidProfit) {
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓未盈利，跳过`);
                continue;
            }

            if (!isValidPrice(calculatedEntryPrice) && isValidPrice(currentPrice) && profitData !== undefined) {
                const profitValue = parseFloat(profitData);
                if (!isNaN(profitValue) && profitValue > 0) {
                    if (direction === 'buy') {
                        calculatedEntryPrice = currentPrice / (1 + profitValue / 100);
                    } else {
                        calculatedEntryPrice = currentPrice / (1 - profitValue / 100);
                    }
                    if (isValidPrice(calculatedEntryPrice)) {
                        logger.info(`用户 ${userOption.userId} 的 ${symbol} 从unrealisedPnl反推入场价格: ${calculatedEntryPrice.toFixed(4)}`);
                    }
                }
            }

            if (!isValidPrice(calculatedEntryPrice)) {
                logger.warn(`持仓数据缺少入场价格，跳过: ${JSON.stringify(position)}`);
                continue;
            }

            if (actualProfitPercentage >= profitProtectionThreshold) {
                const protectionPrice = calculateProtectionPrice(parseFloat(calculatedEntryPrice), direction, userOption);
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 盈利 ${actualProfitPercentage.toFixed(2)}%，达到触发阈值 ${profitProtectionThreshold}%，使用入场价格 ${calculatedEntryPrice}，设置保护止损价格为 ${protectionPrice.toFixed(4)}`);

                const updateResult = await retryAsync(
                    () => updateProtectionStopLoss(userOption, symbol, direction, protectionPrice, exchange),
                    3,
                    1500
                );
                if (updateResult.success) {
                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 保护止损单更新成功`);
                    result.updatedCount++;
                    result.symbols.push(symbol);
                } else {
                    logger.error(`用户 ${userOption.userId} 的 ${symbol} 保护止损单更新失败: ${updateResult.message}`);
                }
            } else {
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 盈利 ${actualProfitPercentage.toFixed(2)}%，未达到触发阈值 ${profitProtectionThreshold}%，跳过`);
            }
        }
        
        logger.info(`用户 ${userOption.userId} 的盈利保护处理完成，更新了 ${result.updatedCount} 个止损单`);
        return result;
    } catch (error) {
        logger.error(`处理用户 ${userOption.userId} 的盈利保护时出错:`, error);
        return { success: false, message: '处理盈利保护时出错', error: error.message };
    }
};

/**
 * 处理盈利保护
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @returns {Promise<Object>} 处理结果
 * 
 * 自动模式：从外部API获取用户持仓信息（包含价格和盈利数据），不需要查询数据库价格
 */
export const handleProfitProtection = async (req, res) => {
    try {
        logger.info('开始处理盈利保护（自动模式）');
        
        // 查询所有开启了盈利保护的用户
        const usersWithProfitProtection = await retryAsync(
            () => UserTradeOptionsModel.find({
                isProfitProtectionEnabled: true,
                isActive: true
            }),
            2,
            1000
        );
        
        if (usersWithProfitProtection.length === 0) {
            logger.info('没有开启盈利保护的用户，退出处理');
            return res.status(200).json({ success: true, message: '没有开启盈利保护的用户' });
        }

        logger.info(`找到 ${usersWithProfitProtection.length} 个开启了盈利保护的用户`);
        
        // 对每个用户处理盈利保护
        const results = [];
        for (const userOption of usersWithProfitProtection) {
            const userResult = await handleUserProfitProtection(userOption);
            results.push({ userId: userOption.userId, ...userResult });
        }

        logger.info('盈利保护处理完成（自动模式）');
        return res.status(200).json({ 
            success: true, 
            message: '盈利保护处理完成', 
            mode: 'auto',
            data: results 
        });
    } catch (error) {
        logger.error('处理盈利保护时出错:', error);
        return res.status(500).json({ success: false, message: '处理盈利保护时出错', error: error.message });
    }
};