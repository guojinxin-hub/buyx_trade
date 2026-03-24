import { UserTradeOptionsModel } from "buydip_scheme";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { updateProtectionStopLoss, getUserPositions } from "./apiTrade.js";

/**
 * 日志记录工具
 * 提供统一的日志输出格式，包含时间戳和日志级别
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
 * 当API调用失败时自动重试，提高系统稳定性
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
 * 根据当前价格和入场价格计算持仓盈利百分比
 * @param {number} currentPrice - 当前价格
 * @param {number} entryPrice - 入场价格
 * @param {string} direction - 交易方向，'buy'表示做多，'sell'表示做空
 * @returns {number} 盈利比例（百分比），盈利为正数，亏损为负数
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
        // 做多：盈利 = (当前价格 - 入场价格) / 入场价格 * 100
        return ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
        // 做空：盈利 = (入场价格 - 当前价格) / 入场价格 * 100
        return ((entryPrice - currentPrice) / entryPrice) * 100;
    }
};

/**
 * 计算保护止损价格
 * 当持仓盈利达到一定阈值时，设置保护性止损价格以锁定利润
 * @param {number} entryPrice - 入场价格
 * @param {string} direction - 交易方向，'buy'表示做多，'sell'表示做空
 * @param {Object} userOption - 用户配置对象
 * @returns {number} 保护止损价格
 */
const calculateProtectionPrice = (entryPrice, direction, userOption) => {
    // 从用户配置中获取保护止损价格比例，默认为2%
    // 这个比例决定了止损价格相对于入场价格的偏移量
    const protectionPercentage = 2;

    if (direction === 'buy') {
        // 做多单：止损价格 = 入场价格 * (1 + 保护比例)
        // 例如：入场价100，保护比例2%，止损价 = 100 * 1.02 = 102
        // 当价格下跌到102时触发止损，保护已获得的盈利
        return entryPrice * (1 + protectionPercentage / 100);
    } else {
        // 做空单：止损价格 = 入场价格 * (1 - 保护比例)
        // 例如：入场价100，保护比例2%，止损价 = 100 * 0.98 = 98
        // 当价格上涨到98时触发止损，保护已获得的盈利
        return entryPrice * (1 - protectionPercentage / 100);
    }
};

/**
 * 检查价格是否有效
 * 验证价格数据是否为有效的正数
 * @param {string|number} price - 价格值
 * @returns {boolean} 如果价格有效返回true，否则返回false
 */
const isValidPrice = (price) => {
    if (!price) return false;
    const priceNum = parseFloat(price);
    return !isNaN(priceNum) && priceNum > 0;
};

/**
 * 处理单个用户的盈利保护
 * 遍历用户的所有持仓，检查是否达到盈利保护条件，并更新止损单
 * @param {Object} userOption - 用户配置对象，包含用户ID、API密钥等信息
 * @returns {Promise<Object>} 处理结果，包含成功状态、更新数量等信息
 */
const handleUserProfitProtection = async (userOption) => {
    try {
        // 验证用户配置是否有效
        if (!userOption || !userOption.userId) {
            logger.error('无效的用户配置');
            return { success: false, message: '无效的用户配置' };
        }

        logger.info(`开始处理用户 ${userOption.userId} 的盈利保护`);

        // 从交易所API获取用户的最新持仓信息
        const positions = await getUserPositions(userOption);

        // 提取用户的持仓币种列表，用于日志记录
        const positionSymbols = positions.map(p => p.symbol.toUpperCase());
        logger.info(`用户 ${userOption.userId} 的持仓币种:`, positionSymbols);

        // 查询数据库中该用户的pending状态订单
        // 只查询与用户配置平台匹配的订单
        const userPlatform = userOption.belong?.toLowerCase() || 'binance';
        const pendingOrders = await TradeRecordModel.find({
            userId: userOption.userId,
            status: 'pending',
            exchange: userPlatform
        });

        logger.info(`用户 ${userOption.userId} 有 ${pendingOrders.length} 个 pending 状态的订单`);

        // 检查并更新不在持仓中的订单状态
        // 如果数据库中有订单但用户实际没有持仓，则将订单状态改为cancelled
        for (const order of pendingOrders) {
            const orderSymbol = order.symbol.toUpperCase();
            const orderExchange = order.exchange || 'binance';

            // 检查该订单在对应交易所是否有持仓
            const hasPosition = positions.some(p =>
                p.symbol.toUpperCase() === orderSymbol &&
                (p.exchange || 'binance') === orderExchange
            );

            if (!hasPosition) {
                logger.info(`用户 ${userOption.userId} 的 ${orderSymbol} 订单在 ${orderExchange} 交易所不在持仓中，将状态改为 cancelled`);
                await TradeRecordModel.findByIdAndUpdate(order._id, {
                    status: 'cancelled'
                });
            }
        }

        // 如果没有持仓，直接返回
        if (positions.length === 0) {
            logger.info(`用户 ${userOption.userId} 没有持仓`);
            return { success: true, message: '没有持仓', updatedCount: 0 };
        }

        logger.info(`用户 ${userOption.userId} 有 ${positions.length} 个持仓`);

        // 获取用户在数据库中的币种列表
        const tradeRecordSymbols = pendingOrders.map(o => o.symbol.toUpperCase());
        logger.info(`用户 ${userOption.userId} 在 TradeRecordModel 中的币种:`, tradeRecordSymbols);

        // 盈利保护触发阈值，默认为5%
        // 当持仓盈利达到或超过这个阈值时，触发盈利保护机制
        const profitProtectionThreshold = 5;

        // 初始化处理结果对象
        const result = {
            success: true,
            message: '盈利保护处理完成',
            updatedCount: 0,
            symbols: []
        };

        // 遍历每个持仓，处理盈利保护
        for (const position of positions) {
            const { symbol, direction, exchange = 'binance' } = position;

            // 检查持仓数据是否包含必要的基本信息
            if (!symbol || !direction) {
                logger.warn(`持仓数据缺少基本信息，跳过: ${JSON.stringify(position)}`);
                continue;
            }

            // 检查该币种是否在数据库的TradeRecordModel中
            // 只有数据库中有记录的订单才需要处理盈利保护
            const positionSymbolUpper = symbol.toUpperCase();
            if (!tradeRecordSymbols.includes(positionSymbolUpper)) {
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 不在 TradeRecordModel 中，跳过盈利保护`);
                continue;
            }

            // 直接使用交易所API返回的收益率百分比（已包含杠杆）
            // unrealisedPnl 字段已经在 getGatePositions 和 getBinancePositions 中计算完成
            const actualProfitPercentage = parseFloat(position.unrealisedPnl) || 0;

            // 判断是否有有效盈利
            if (actualProfitPercentage <= 0) {
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓未盈利，跳过`);
                continue;
            }

            logger.info(`用户 ${userOption.userId} 的 ${symbol} 持仓盈利 ${actualProfitPercentage.toFixed(2)}%`);

            // 获取入场价格用于计算保护止损价格
            const entryPrice = position.entryPrice || position.price || position.avgPrice;

            // 检查是否达到盈利保护触发阈值
            if (actualProfitPercentage >= profitProtectionThreshold) {
                // 计算保护止损价格
                const protectionPrice = calculateProtectionPrice(parseFloat(entryPrice), direction, userOption);
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 盈利 ${actualProfitPercentage.toFixed(2)}%，达到触发阈值 ${profitProtectionThreshold}%，使用入场价格 ${entryPrice}，设置保护止损价格为 ${protectionPrice.toFixed(4)}`);
                
                // 调用API更新保护止损单，传入入场价格
                const updateResult = await updateProtectionStopLoss(userOption, symbol, direction, protectionPrice, exchange, entryPrice);
                if (updateResult.success) {
                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 保护止损单更新成功`);
                    result.updatedCount++;
                    result.symbols.push(symbol);
                } else {
                    logger.error(`用户 ${userOption.userId} 的 ${symbol} 保护止损单更新失败: ${updateResult.message}`);
                }
            } else {
                // 未达到触发阈值，记录日志并跳过
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
 * 计算持仓的盈利信息
 * 根据入场价格和当前价格计算盈利百分比，并判断是否满足盈利保护条件
 * @param {number} entryPrice - 入场价格，用户开仓时的价格
 * @param {number} currentPrice - 当前价格，持仓的实时市场价格
 * @param {string} direction - 交易方向，'buy'表示做多（看涨），'sell'表示做空（看跌）
 * @param {string} userId - 用户ID，用于日志记录
 * @param {string} symbol - 交易对符号，例如'BTC'、'ETH'等，用于日志记录
 * @returns {Object} 盈利信息对象，包含以下属性：
 *   - actualProfitPercentage: {number} 实际盈利百分比，盈利为正数，亏损为负数
 *   - hasValidProfit: {boolean} 是否有有效盈利（盈利>0）
 *   - calculatedEntryPrice: {number} 计算使用的入场价格
 */
const calculateProfitInfo = (entryPrice, currentPrice, direction, userId, symbol) => {
    // 初始化返回值
    let actualProfitPercentage = 0;
    let hasValidProfit = false;
    let calculatedEntryPrice = entryPrice;

    // 检查价格数据是否有效
    // 如果入场价格或当前价格无效，无法计算盈利，直接返回
    if (!isValidPrice(currentPrice) || !isValidPrice(entryPrice)) {
        logger.info(`用户 ${userId} 的 ${symbol} 持仓数据不足，跳过`);
        return { actualProfitPercentage, hasValidProfit, calculatedEntryPrice };
    }

    // 调用calculateProfitPercentage函数计算盈利百分比
    // 该函数会根据交易方向（做多/做空）使用不同的计算公式
    actualProfitPercentage = calculateProfitPercentage(currentPrice, entryPrice, direction);

    // 判断是否有有效盈利
    // 只有当盈利百分比大于0时，才认为有有效盈利
    if (actualProfitPercentage > 0) {
        hasValidProfit = true;
        logger.info(`用户 ${userId} 的 ${symbol} 持仓盈利 ${actualProfitPercentage.toFixed(2)}%`);
    } else {
        // 盈利小于等于0，记录日志但不设置hasValidProfit为true
        logger.info(`用户 ${userId} 的 ${symbol} 持仓未盈利，跳过`);
    }

    // 返回盈利信息对象
    return { actualProfitPercentage, hasValidProfit, calculatedEntryPrice };
};

/**
 * 处理盈利保护（自动模式）
 * 遍历所有开启盈利保护的用户，逐个处理其持仓的盈利保护
 * @param {Object} req - HTTP请求对象
 * @param {Object} res - HTTP响应对象
 * @returns {Promise<Object>} HTTP响应结果
 * 
 * 自动模式说明：
 * - 从交易所API直接获取用户持仓信息（包含价格和盈利数据）
 * - 不需要查询数据库中的价格数据
 * - 根据持仓盈亏情况自动更新保护止损单
 */
export const handleProfitProtection = async (req, res) => {
    try {
        logger.info('开始处理盈利保护（自动模式）');

        // 查询所有开启了盈利保护且状态为活跃的用户
        const usersWithProfitProtection = await UserTradeOptionsModel.find({
            isProfitProtectionEnabled: true,
            isActive: true
        });
        
        // 如果没有开启盈利保护的用户，直接返回
        if (usersWithProfitProtection.length === 0) {
            logger.info('没有开启盈利保护的用户，退出处理');
            return res.status(200).json({ success: true, message: '没有开启盈利保护的用户' });
        }
        
        logger.info(`找到 ${usersWithProfitProtection.length} 个开启了盈利保护的用户`);

        // 逐个处理每个用户的盈利保护
        const results = [];
        for (const userOption of usersWithProfitProtection) {
            // const userResult = await handleUserProfitProtection(userOption);
            results.push({ userId: userOption.userId, ...userResult });
        }

        // 返回处理结果
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
