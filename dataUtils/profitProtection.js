import { UserTradeOptionsModel, TradeRecordModel, CoinPriceModel } from "buydip_scheme";
import { updateProtectionStopLoss } from "./apiTrade";

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
    const protectionPercentage = userOption?.profitProtectionPercentage || 2;

    if (direction === 'buy') {
        return entryPrice * (1 + protectionPercentage / 100); // 买入单：入场价格*(1+保护比例)
    } else {
        return entryPrice * (1 - protectionPercentage / 100); // 卖出单：入场价格*(1-保护比例)
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
 * 处理单个交易记录的盈利保护
 * @param {Object} userOption - 用户配置
 * @param {Object} record - 交易记录
 * @param {number} currentPrice - 当前价格
 * @returns {Promise<boolean>} 是否成功更新止损单
 */
const handleSingleTradeRecord = async (userOption, record, currentPrice) => {
    try {
        const symbol = record.symbol;
        const entryPrice = parseFloat(record.price);
        const direction = record.direction;
        const exchange = record.exchange;

        // 计算盈利比例
        const profitPercentage = calculateProfitPercentage(currentPrice, entryPrice, direction);

        logger.info(`用户 ${userOption.userId} 的 ${symbol} 交易记录盈利 ${profitPercentage.toFixed(2)}%`);

        // 从用户配置中获取盈利保护触发阈值，默认为10%
        const profitProtectionThreshold = userOption?.profitProtectionThreshold || 10;

        // 如果盈利超过触发阈值，计算保护止损价格并设置
        if (profitPercentage >= profitProtectionThreshold) {
            const protectionPrice = calculateProtectionPrice(entryPrice, direction, userOption);
            logger.info(`用户 ${userOption.userId} 的 ${symbol} 盈利 ${profitPercentage.toFixed(2)}%，达到触发阈值 ${profitProtectionThreshold}%，设置保护止损价格为 ${protectionPrice.toFixed(4)}`);

            // 调用盈利保护服务更新止损单，使用重试机制
            const result = await retryAsync(
                () => updateProtectionStopLoss(userOption, symbol, direction, protectionPrice, exchange),
                3, // 最大重试3次
                1500 // 每次重试间隔1500ms
            );
            if (result.success) {
                logger.info(`用户 ${userOption.userId} 的 ${symbol} 保护止损单更新成功`);

                // 保存保护价格到记录对象，以便后续更新其他记录使用
                record.protectionPrice = protectionPrice;
                record.profitProtectionThreshold = profitProtectionThreshold;

                return true;
            } else {
                logger.error(`用户 ${userOption.userId} 的 ${symbol} 保护止损单更新失败: ${result.message}`);
            }
        } else {
            logger.info(`用户 ${userOption.userId} 的 ${symbol} 盈利 ${profitPercentage.toFixed(2)}%，未达到触发阈值 ${profitProtectionThreshold}%，跳过`);
        }

        return false;
    } catch (error) {
        logger.error(`处理单个交易记录时出错:`, error);
        return false;
    }
};

/**
 * 处理单个用户的盈利保护
 * @param {Object} userOption - 用户配置
 * @param {Object} priceMap - 价格映射
 * @returns {Promise<Object>} 处理结果
 */
const handleUserProfitProtection = async (userOption, priceMap) => {
    try {
        // 验证用户配置
        if (!userOption || !userOption.userId) {
            logger.error('无效的用户配置');
            return { success: false, message: '无效的用户配置' };
        }

        logger.info(`开始处理用户 ${userOption.userId} 的盈利保护`);

        // 查询用户的所有未平仓交易记录，使用重试机制
        const tradeRecords = await retryAsync(
            () => TradeRecordModel.find({
                userId: userOption.userId,
                status: 'pending'
            }).sort({ createdAt: -1 }),
            2, // 最大重试2次
            1000 // 每次重试间隔1000ms
        );

        if (tradeRecords.length === 0) {
            logger.info(`用户 ${userOption.userId} 没有待处理的交易记录`);
            return { success: true, message: '没有待处理的交易记录', updatedCount: 0 };
        }

        logger.info(`用户 ${userOption.userId} 有 ${tradeRecords.length} 条未平仓交易记录`);

        // 按币种分组处理交易记录
        const symbolGroups = {};
        for (const record of tradeRecords) {
            const symbol = record.symbol;
            if (!symbolGroups[symbol]) {
                symbolGroups[symbol] = [];
            }
            symbolGroups[symbol].push(record);
        }

        logger.info(`用户 ${userOption.userId} 有 ${Object.keys(symbolGroups).length} 个币种需要处理`);

        // 处理结果
        const result = {
            success: true,
            message: '盈利保护处理完成',
            updatedCount: 0,
            symbols: []
        };

        // 对每个币种计算盈利并设置保护止损
        for (const [symbol, records] of Object.entries(symbolGroups)) {
            // 从价格映射中获取当前价格
            const currentPriceStr = priceMap[symbol];
            if (!isValidPrice(currentPriceStr)) {
                logger.info(`无法获取 ${symbol} 的有效价格，跳过`);
                result.symbols.push({ symbol, success: false, message: '无法获取有效价格' });
                continue;
            }

            const currentPrice = parseFloat(currentPriceStr);

            // 处理该币种的所有未平仓记录
            let hasUpdatedStopLoss = false;
            for (const record of records) {
                // 检查是否已经设置了保护止损，避免重复设置
                if (record.hasProtectionStop) {
                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 交易记录已经设置了保护止损，跳过`);
                    continue;
                }

                const updated = await handleSingleTradeRecord(userOption, record, currentPrice);
                if (updated) {
                    hasUpdatedStopLoss = true;

                }

                if (hasUpdatedStopLoss) {
                    result.symbols.push({ symbol, success: true, message: '保护止损已更新' });
                } else {
                    logger.info(`用户 ${userOption.userId} 的 ${symbol} 没有需要更新保护止损的交易记录`);
                    result.symbols.push({ symbol, success: true, message: '没有需要更新保护止损的交易记录' });
                }
            }

        }
        logger.info(`用户 ${userOption.userId} 的盈利保护处理完成`);
        return result;
    } catch (error) {
        logger.error(`处理用户 ${userOption.userId} 的盈利保护时出错:`, error);
        return { success: false, message: '处理盈利保护时出错', error: error.message };
    }
};

/**
 * 处理盈利保护
 * @param {Object} options - 选项参数
 * @param {string} options.userId - 用户ID（可选，如果提供则只处理该用户）
 * @param {Array<string>} options.symbols - 交易对列表（可选，如果提供则只处理这些交易对）
 * @returns {Promise<Object>} 处理结果
 */
export const handleProfitProtection = async (req, res) => {
    try {
        logger.info('开始处理盈利保护');
        // 查询用户配置
        let usersWithProfitProtection = await retryAsync(
            () => UserTradeOptionsModel.find({
                isProfitProtectionEnabled: true,
                isActive: true
            }),
            2, // 最大重试2次
            1000 // 每次重试间隔1000ms
        );
        if (usersWithProfitProtection.length === 0) {
            logger.info('没有开启盈利保护的用户，退出处理');
            return { success: true, message: '没有开启盈利保护的用户' };
        }

        logger.info(`找到 ${usersWithProfitProtection.length} 个开启了盈利保护的用户`);

        // 3. 获取交易记录的交易对
        let tradeRecordSymbols = await retryAsync(
            () => TradeRecordModel.distinct('symbol'),
            2, // 最大重试2次
            1000 // 每次重试间隔1000ms
        );
        logger.info(`找到 ${tradeRecordSymbols.length} 个交易对`);
        if (tradeRecordSymbols.length === 0) {
            logger.info('没有交易记录，退出处理');
            return res.status(200).json({ success: true, message: '没有交易记录' });
        }

        // 4. 从 CoinPriceModel 获取这些交易对的最新价格
        const coinPriceList = await retryAsync(
            () => CoinPriceModel.find({
                symbol: { $in: tradeRecordSymbols }
            }),
            2, // 最大重试2次
            1000 // 每次重试间隔1000ms
        );
        // 5. 转换为 map 以便快速查找价格
        const priceMap = {};
        coinPriceList.forEach(item => {
            if (isValidPrice(item.lastPrice)) {
                priceMap[item.symbol] = item.lastPrice;
            }
        });
        logger.info(`获取了 ${Object.keys(priceMap).length} 个交易对的有效价格`);
        if (Object.keys(priceMap).length === 0) {
            logger.info('没有有效价格数据，退出处理');
            return res.status(200).json({ success: true, message: '没有有效价格数据' });
        }
        // 6. 对每个用户处理盈利保护
        const results = [];
        for (const userOption of usersWithProfitProtection) {
            const userResult = await handleUserProfitProtection(userOption, priceMap);
            results.push({ userId: userOption.userId, ...userResult });
        }

        logger.info('盈利保护处理完成');
        return res.status(200).json({ success: true, message: '盈利保护处理完成', data: results });
    } catch (error) {
        logger.error('处理盈利保护时出错:', error);
        return res.status(500).json({ success: false, message: '处理盈利保护时出错', error: error.message });
    }
};
