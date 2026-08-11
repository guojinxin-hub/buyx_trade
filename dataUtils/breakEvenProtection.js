/**
 * 保本触发策略模块
 *
 * 业务逻辑：
 * 通过API每5分钟更新一次持仓单的盈利状况
 * 当持仓浮盈 ≥ profitThreshold（默认4%）时启动保本止损：
 *   做多：止损价移至 入场价 × longMultiplier（默认 1.01）
 *   做空：止损价移至 入场价 × shortMultiplier（默认 0.99）
 *
 * 参数可通过后台 BreakEvenConfigModel 配置
 */
import {UserTradeOptionsModel, UserPositionModel, BreakEvenConfigModel} from "buydip_scheme";
import {getUserPositions, updateProtectionStopLoss} from "./apiTrade";

const logger = {
    info: (...args) => console.log('[BREAK_EVEN]', new Date().toISOString(), ...args),
    warn: (...args) => console.warn('[BREAK_EVEN]', new Date().toISOString(), ...args),
    error: (...args) => console.error('[BREAK_EVEN]', new Date().toISOString(), ...args)
};

// 默认配置
const DEFAULT_CONFIG = {
    profitThreshold: 4,
    longMultiplier: 1.01,
    shortMultiplier: 0.99,
    checkInterval: 5 * 60 * 1000,
    enabled: true
};

let currentConfig = {...DEFAULT_CONFIG};

/**
 * 从数据库加载保本触发配置
 */
async function loadConfig() {
    try {
        const config = await BreakEvenConfigModel.findOne().sort({createdAt: -1}).lean();
        if (config) {
            currentConfig = {
                profitThreshold: config.profitThreshold,
                longMultiplier: config.longMultiplier,
                shortMultiplier: config.shortMultiplier,
                checkInterval: config.checkInterval,
                enabled: config.enabled
            };
            logger.info('保本触发配置已加载:', currentConfig);
        } else {
            // 无配置时创建默认配置
            await BreakEvenConfigModel.create(DEFAULT_CONFIG);
            currentConfig = {...DEFAULT_CONFIG};
            logger.info('创建默认保本触发配置:', currentConfig);
        }
    } catch (error) {
        logger.error('加载保本触发配置失败，使用默认配置:', error.message);
    }
}

/**
 * 计算保本止损价格
 * @param {number} entryPrice - 入场价格
 * @param {string} direction - 方向 buy/sell
 * @returns {number} 止损价格
 */
const calculateBreakEvenStopLoss = (entryPrice, direction) => {
    if (direction === 'buy') {
        // 做多：止损价 = 入场价 × longMultiplier（略高于入场价，锁定小额利润）
        return entryPrice * currentConfig.longMultiplier;
    } else {
        // 做空：止损价 = 入场价 × shortMultiplier（略低于入场价）
        return entryPrice * currentConfig.shortMultiplier;
    }
};

/**
 * 处理单个用户的保本触发
 * @param {Object} userOption - 用户交易配置
 * @returns {Promise<Object>} 处理结果
 */
const handleUserBreakEven = async (userOption) => {
    try {
        if (!userOption || !userOption.userId) {
            return {success: false, message: '无效的用户配置'};
        }

        const {profitThreshold} = currentConfig;
        const exchange = userOption.belong || '';

        logger.info(`开始检查用户 ${userOption.userId}（${exchange}）的保本触发`);

        // 获取用户实时持仓
        const positions = await getUserPositions(userOption);

        if (!positions || positions.length === 0) {
            return {success: true, message: '无持仓', triggered: 0};
        }

        let triggeredCount = 0;

        for (const position of positions) {
            const {symbol, direction, entryPrice} = position;

            if (!symbol || !direction || !entryPrice) {
                continue;
            }

            // 查询该持仓的保本触发状态
            const positionRecord = await UserPositionModel.findOne({
                userId: userOption.userId,
                exchange,
                symbol
            }).lean();

            // 已触发过保本止损则跳过（避免重复设置）
            if (positionRecord?.breakEvenTriggered) {
                continue;
            }

            // 计算单个币种的浮盈 ROI（含杠杆）
            // ROI = 价格变动% × 杠杆
            const entry = parseFloat(entryPrice) || 0;
            const current = parseFloat(position.currentPrice || position.markPrice) || 0;
            const leverage = parseFloat(position.leverage) || 1;

            let profitPercentage = 0;
            if (entry > 0 && current > 0) {
                const priceChangePercent = direction === 'buy'
                    ? ((current - entry) / entry) * 100   // 做多：(现价-入场价)/入场价
                    : ((entry - current) / entry) * 100;  // 做空：(入场价-现价)/入场价
                profitPercentage = priceChangePercent * leverage;
            }

            if (profitPercentage < profitThreshold) {
                continue;
            }

            logger.info(`用户 ${userOption.userId} 的 ${symbol}（${direction}）浮盈 ${profitPercentage.toFixed(2)}% ≥ ${profitThreshold}%，触发保本止损`);

            // 计算保本止损价
            const stopLossPrice = calculateBreakEvenStopLoss(parseFloat(entryPrice), direction);
            logger.info(`${symbol} 入场价 ${entryPrice}，保本止损价 ${stopLossPrice.toFixed(4)}`);

            // 调用交易所API设置止损单
            const exchangeLower = exchange.toLowerCase();
            const updateResult = await updateProtectionStopLoss(
                userOption, symbol, direction, stopLossPrice, exchangeLower, entryPrice
            );

            if (updateResult.success) {
                // 标记该持仓已触发保本止损
                await UserPositionModel.updateOne(
                    {userId: userOption.userId, exchange, symbol},
                    {$set: {breakEvenTriggered: true}}
                );
                triggeredCount++;
                logger.info(`${symbol} 保本止损设置成功`);
            } else {
                logger.error(`${symbol} 保本止损设置失败: ${updateResult.message}`);
            }
        }

        return {success: true, message: '保本触发检查完成', triggered: triggeredCount};
    } catch (error) {
        logger.error(`处理用户 ${userOption.userId} 保本触发失败:`, error.message);
        return {success: false, message: error.message};
    }
};

/**
 * 执行保本触发检查（定时任务入口）
 * @returns {Promise<Object>} 处理结果
 */
export const handleBreakEvenProtection = async () => {
    try {
        if (!currentConfig.enabled) {
            return {success: true, message: '保本触发未启用'};
        }

        logger.info('========== 开始执行保本触发检查 ==========');

        // 获取所有激活且开启盈利保护的用户
        const activeUsers = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
            isProfitProtectionEnabled: true
        }).lean();

        if (activeUsers.length === 0) {
            logger.info('没有开启盈利保护的活跃用户');
            return {success: true, message: '无活跃用户'};
        }

        logger.info(`找到 ${activeUsers.length} 个活跃用户`);

        const results = [];
        for (const userOption of activeUsers) {
            const result = await handleUserBreakEven(userOption);
            results.push({userId: userOption.userId, ...result});
        }

        const totalTriggered = results.reduce((sum, r) => sum + (r.triggered || 0), 0);
        logger.info(`========== 保本触发检查完成，共触发 ${totalTriggered} 个止损单 ==========`);

        return {success: true, message: '保本触发检查完成', totalTriggered, data: results};
    } catch (error) {
        logger.error('执行保本触发检查失败:', error.message);
        return {success: false, message: error.message};
    }
};

/**
 * 启动保本触发定时任务（每5分钟执行一次）
 */
export const startBreakEvenProtectionScheduler = async () => {
    await loadConfig();

    const interval = currentConfig.checkInterval;
    logger.info(`启动保本触发定时任务，间隔: ${interval / 1000 / 60} 分钟`);

    // 立即执行一次
    handleBreakEvenProtection();

    // 设置定时任务
    setInterval(handleBreakEvenProtection, interval);

    // 每5分钟重新加载配置
    setInterval(loadConfig, 5 * 60 * 1000);
};

/**
 * 手动触发保本检查（API接口）
 */
export const triggerBreakEvenProtection = async (req, res) => {
    try {
        const result = await handleBreakEvenProtection();
        return res.status(200).json(result);
    } catch (error) {
        logger.error('手动触发保本检查失败:', error.message);
        return res.status(500).json({success: false, message: error.message});
    }
};
