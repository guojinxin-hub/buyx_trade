import { UserTradeOptionsModel, ProfitProtectionStatusModel, FloatingProfitConfigModel, PageDataModel } from "buydip_scheme";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { executeClosePositions } from "./closePositions";
import { getUserPositions } from "./apiTrade";

/**
 * 日志记录工具
 */
const logger = {
    info: (...args) => {
        console.log('[FLOATING_PROFIT]', new Date().toISOString(), ...args);
    },
    warn: (...args) => {
        console.warn('[FLOATING_PROFIT]', new Date().toISOString(), ...args);
    },
    error: (...args) => {
        console.error('[FLOATING_PROFIT]', new Date().toISOString(), ...args);
    }
};

/**
 * 获取用户的盈利保护状态
 * @param {String} userId - 用户ID
 * @returns {Object} 用户的盈利保护状态
 */
async function getProfitProtectionStatus(userId, exchange = '') {
    try {
        let status = await ProfitProtectionStatusModel.findOne({ userId, exchange });
        if (!status) {
            // 尝试创建新记录
            try {
                status = new ProfitProtectionStatusModel({ userId, exchange });
                await status.save();
                logger.info(`为用户 ${userId} 创建了新的盈利保护状态记录，交易所: ${exchange}`);
            } catch (saveError) {
                if (saveError.code === 11000) {
                    // 遇到重复键错误，返回默认状态
                    logger.warn(`用户 ${userId} 的记录已存在，返回默认状态`);
                    return {
                        userId,
                        exchange,
                        state: 'IDLE',
                        highestProfitRate: 0,
                        activatedAt: null,
                        triggeredAt: null,
                        totalFloatingProfitRate: 0
                    };
                } else {
                    throw saveError;
                }
            }
        }
        return status;
    } catch (error) {
        logger.error(`获取用户 ${userId} 的盈利保护状态时出错:`, error);
        // 返回默认状态
        return {
            userId,
            exchange,
            state: 'IDLE',
            highestProfitRate: 0,
            activatedAt: null,
            triggeredAt: null,
            totalFloatingProfitRate: 0
        };
    }
}

/**
 * 更新用户的盈利保护状态
 * @param {String} userId - 用户ID
 * @param {Object} updates - 要更新的状态字段
 * @returns {Object} 更新后的状态对象
 */
async function updateProfitProtectionStatus(userId, updates) {
    try {
        const { exchange = '' } = updates;
        // 先尝试查找记录
        let status = await ProfitProtectionStatusModel.findOne({ userId, exchange });
        if (status) {
            // 记录存在，更新它
            status = await ProfitProtectionStatusModel.findOneAndUpdate(
                { userId, exchange },
                {
                    $set: {
                        ...updates,
                        lastUpdatedAt: new Date()
                    }
                },
                { new: true }
            );
        } else {
            // 记录不存在，尝试创建新记录
            try {
                status = new ProfitProtectionStatusModel({
                    userId,
                    exchange,
                    ...updates,
                    lastUpdatedAt: new Date()
                });
                await status.save();
            } catch (saveError) {
                if (saveError.code === 11000) {
                    // 遇到重复键错误，返回 null
                    logger.warn(`用户 ${userId} 的记录已存在，无法更新`);
                    return null;
                } else {
                    throw saveError;
                }
            }
        }
        return status;
    } catch (error) {
        logger.error(`更新用户 ${userId} 的盈利保护状态时出错:`, error);
        return null;
    }
}

/**
 * 重置用户的盈利保护状态
 * @param {String} userId - 用户ID
 * @returns {Object} 重置后的状态对象
 */
async function resetProfitProtectionStatus(userId, exchange = '') {
    try {
        // 先尝试查找记录
        let status = await ProfitProtectionStatusModel.findOne({ userId, exchange });
        if (status) {
            // 记录存在，更新它
            status = await ProfitProtectionStatusModel.findOneAndUpdate(
                { userId, exchange },
                {
                    $set: {
                        state: 'IDLE',
                        highestProfitRate: 0,
                        activatedAt: null,
                        triggeredAt: null,
                        totalFloatingProfitRate: 0,
                        lastUpdatedAt: new Date()
                    }
                },
                { new: true }
            );
        } else {
            // 记录不存在，尝试创建新记录
            try {
                status = new ProfitProtectionStatusModel({
                    userId,
                    exchange,
                    state: 'IDLE',
                    highestProfitRate: 0,
                    activatedAt: null,
                    triggeredAt: null,
                    totalFloatingProfitRate: 0,
                    lastUpdatedAt: new Date()
                });
                await status.save();
            } catch (saveError) {
                if (saveError.code === 11000) {
                    // 遇到重复键错误，返回 null
                    logger.warn(`用户 ${userId} 的记录已存在，无法重置`);
                    return null;
                } else {
                    throw saveError;
                }
            }
        }
        return status;
    } catch (error) {
        logger.error(`重置用户 ${userId} 的盈利保护状态时出错:`, error);
        return null;
    }
}

/**
 * 配置参数
 */
let CONFIG = {
    TRIGGER_PROTECTION_VALUE: 4,     // 触发保护值（%）
    PROTECTION_VALUE: 1,              // 保护值（%）
    TAKE_PROFIT_CLOSE_VALUE: 10,      // 止盈平仓值（%）
    MONITORING_INTERVAL: 5 * 60 * 1000 // 监控间隔（5分钟）
};

/**
 * 从数据库加载配置参数
 */
async function loadConfig() {
    try {
        const config = await FloatingProfitConfigModel.findOne({});
        if (config) {
            CONFIG = {
                TRIGGER_PROTECTION_VALUE: config.triggerProtectionValue,
                PROTECTION_VALUE: config.protectionValue,
                TAKE_PROFIT_CLOSE_VALUE: config.takeProfitValue,
                MONITORING_INTERVAL: config.monitoringInterval
            };
            logger.info('成功加载浮动盈利保护配置:', CONFIG);
        } else {
            // 如果配置不存在，创建默认配置
            const defaultConfig = {
                triggerProtectionValue: 4,
                protectionValue: 1,
                takeProfitValue: 10,
                monitoringInterval: 5 * 60 * 1000
            };
            const newConfig = new FloatingProfitConfigModel(defaultConfig);
            await newConfig.save();
            logger.info('创建默认浮动盈利保护配置:', defaultConfig);
        }
    } catch (error) {
        logger.error('加载浮动盈利保护配置失败:', error);
        // 加载失败时使用默认配置
    }
}

/**
 * 通用的API调用重试函数
 * @param {Function} fn - 要执行的异步函数
 * @param {Number} maxRetries - 最大重试次数
 * @param {Number} delay - 重试间隔时间（毫秒）
 * @returns {Promise} API调用结果
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
 * 执行全仓平仓
 * @param {Object} userOption - 用户配置
 * @param {string} reason - 平仓原因
 * @returns {Promise<boolean>}
 */
async function executeFullClosePositions(userOption, reason) {
    try {
        logger.info(`执行全仓平仓，原因: ${reason}, 用户: ${userOption.userId}`);

        // 执行平仓
        await executeClosePositions({ userOptions: userOption });

        // 获取交易所信息
        const exchange = userOption.belong || '';

        // 重置监控状态
        await resetProfitProtectionStatus(userOption.userId, exchange);

        logger.info(`用户 ${userOption.userId} 全仓平仓完成`);
        return true;
    } catch (error) {
        logger.error(`执行全仓平仓时出错:`, error);
        return false;
    }
}

/**
 * 检查并处理单个用户的浮动盈利保护
 * @param {Object} userOption - 用户配置对象，包含API密钥、交易所等信息
 * @returns {Promise<Object>} 处理结果
 */
async function handleUserFloatingProfitProtection(userOption) {
    try {
        if (!userOption || !userOption.userId) {
            logger.error('无效的用户配置');
            return { success: false, message: '无效的用户配置' };
        }

        logger.info(`开始处理用户 ${userOption.userId} 的浮动盈利保护`);

        // 初始化各种账户指标变量
        let totalFloatingProfitRate = 0;  // 总浮动收益率
        let totalFloatingProfit = 0;      // 总浮动盈亏金额
        let totalBenchmark = 0;           // 基准总金额（不含浮动盈亏的本金）
        let total = 0;                    // 总资产（含浮动盈亏）
        let availableBalance = 0;         // 可用余额

        try {
            const { belong, apiKey, apiSecret, isTestOption, passphrase } = userOption;

            switch (belong) {
                case 'Binance':
                    {
                        const BinanceFuturesTrade = require('./BinanceFutures/BinanceFuturesTrade');
                        const { decrypt } = require('./utils');
                        const trader = new BinanceFuturesTrade(decrypt(apiKey), decrypt(apiSecret), isTestOption);
                        // 获取账户信息
                        const accountInfo = await retryAsync(() => trader.checkUserAccount(), 3, 3000);
                        const { availableBalance: binanceAvailableBalance, totalUnrealizedProfit, totalWalletBalance } = accountInfo;

                        // 计算总浮动收益率
                        totalFloatingProfit = parseFloat(totalUnrealizedProfit) || 0;
                        totalBenchmark = parseFloat(totalWalletBalance) || 0;
                        total = parseFloat(totalWalletBalance) || 0; // Binance的totalWalletBalance就是不含浮动盈亏的总值
                        availableBalance = parseFloat(binanceAvailableBalance) || 0;
                        totalFloatingProfitRate = totalBenchmark > 0 ? (totalFloatingProfit / totalBenchmark) * 100 : 0;
                    }
                    break;

                case 'Gate':
                    {
                        const GateApi = require('gate-api');
                        const { decrypt } = require('./utils');
                        const TRADE_API_URL = process.env.TRADE_API_URL;
                        const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL;

                        const gateClient = new GateApi.ApiClient();
                        gateClient.setApiKeySecret(decrypt(apiKey), decrypt(apiSecret));
                        gateClient.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL;

                        const futuresApi = new GateApi.FuturesApi(gateClient);
                        const settle = "usdt";

                        // 获取账户信息
                        const accountInfo = await retryAsync(() => futuresApi.listFuturesAccounts(settle), 3, 3000);
                        const accountData = accountInfo.body;
                        // 计算总浮动收益率
                        total = parseFloat(accountData.total) || 0;                           // 总资产（含浮动盈亏）
                        totalFloatingProfit = parseFloat(accountData.unrealisedPnl) || 0;    // 总浮动盈亏等于未实现盈亏
                        totalBenchmark = total - totalFloatingProfit;                       // 基准总金额 = 总资产 - 浮动盈亏（即不含浮动盈亏的本金）
                        availableBalance = parseFloat(accountData.available) || 0;          // 可用余额
                        totalFloatingProfitRate = totalBenchmark > 0 ? (totalFloatingProfit / totalBenchmark) * 100 : 0; // 计算收益率 = (浮动盈亏 / 本金) * 100%
                    }
                    break;

                case 'OKX':
                    {
                        const OKXFuturesTrade = require('./OKXFutures/OKXFuturesTrade');
                        const { decrypt } = require('./utils');
                        const trader = new OKXFuturesTrade(decrypt(apiKey), decrypt(apiSecret), decrypt(passphrase), isTestOption);

                        // 获取账户信息
                        const accountInfo = await retryAsync(() => trader.checkUserAccount(), 3, 3000);

                        // 计算总浮动收益率
                        total = parseFloat(accountInfo.total) || 0;
                        totalFloatingProfit = parseFloat(accountInfo.unrealisedPnl) || 0;
                        totalBenchmark = total - totalFloatingProfit;
                        availableBalance = parseFloat(accountInfo.available) || 0;
                        totalFloatingProfitRate = totalBenchmark > 0 ? (totalFloatingProfit / totalBenchmark) * 100 : 0;
                    }
                    break;

                default:
                    logger.error(`不支持的交易所类型: ${belong}`);
                    return { success: false, message: '不支持的交易所类型' };
            }
        } catch (error) {
            logger.error(`获取账户信息和持仓信息时出错:`, error);
            return { success: false, message: '获取账户信息失败', error: error.message };
        }

        // 获取交易所信息
        const exchange = userOption.belong || '';

        // 获取当前监控状态
        const currentState = await getProfitProtectionStatus(userOption.userId, exchange);
        // 规则判断
        logger.info(`用户 ${userOption.userId} 交易所: ${exchange} 当前总浮动收益率: ${totalFloatingProfitRate.toFixed(2)}%, 监控状态: ${currentState.state}`, {
            totalFloatingProfitRate: totalFloatingProfitRate.toFixed(2),
            totalFloatingProfit: totalFloatingProfit.toFixed(2),
            totalBenchmark: totalBenchmark.toFixed(2),
            total: total.toFixed(2),
            availableBalance: availableBalance.toFixed(2),
            currentState: currentState.state
        });

        // 如果收益率超过止盈阈值，则全部平仓
        if (totalFloatingProfitRate >= CONFIG.TAKE_PROFIT_CLOSE_VALUE) {
            // 主动止盈
            logger.info(`用户 ${userOption.userId} 触发主动止盈，收益率: ${totalFloatingProfitRate.toFixed(2)}% ≥ ${CONFIG.TAKE_PROFIT_CLOSE_VALUE}%`);
            await executeFullClosePositions(userOption, '主动止盈');
            await updateProfitProtectionStatus(userOption.userId, {
                exchange,
                state: 'TRIGGERED',
                triggeredAt: new Date(),
                totalFloatingProfitRate,
                totalFloatingProfit,
                totalBenchmark,
                total,
                availableBalance
            });
            return { success: true, message: '触发主动止盈', action: 'TAKE_PROFIT_CLOSE' };
        } else if (currentState.state === 'MONITORING' && totalFloatingProfitRate <= CONFIG.PROTECTION_VALUE) {
            // 在监控状态下，如果收益率下降到保护值以下，执行保护性平仓
            logger.info(`用户 ${userOption.userId} 触发回撤保护，收益率: ${totalFloatingProfitRate.toFixed(2)}% ≤ ${CONFIG.PROTECTION_VALUE}%`, {
                totalFloatingProfitRate: totalFloatingProfitRate.toFixed(2),
                totalFloatingProfit: totalFloatingProfit.toFixed(2),
                totalBenchmark: totalBenchmark.toFixed(2),
                total: total.toFixed(2),
                availableBalance: availableBalance.toFixed(2)
            });
            await executeFullClosePositions(userOption, '回撤保护');
            await updateProfitProtectionStatus(userOption.userId, {
                exchange,
                state: 'TRIGGERED',
                triggeredAt: new Date(),
                totalFloatingProfitRate,
                totalFloatingProfit,
                totalBenchmark,
                total,
                availableBalance
            });
            return { success: true, message: '触发回撤保护', action: 'PROTECTION_CLOSE' };
        } else if (totalFloatingProfitRate > CONFIG.TRIGGER_PROTECTION_VALUE && totalFloatingProfitRate < CONFIG.TAKE_PROFIT_CLOSE_VALUE) {
            // 收益率在触发保护值和止盈值之间，进入监控状态
            const newHighestProfitRate = Math.max(currentState.highestProfitRate, totalFloatingProfitRate);
            await updateProfitProtectionStatus(userOption.userId, {
                exchange,
                state: 'MONITORING',
                highestProfitRate: newHighestProfitRate,
                activatedAt: currentState.activatedAt || new Date(),
                totalFloatingProfitRate,
                totalFloatingProfit,
                totalBenchmark,
                total,
                availableBalance
            });

            logger.info(`用户 ${userOption.userId} 进入回撤保护监控状态，当前收益率: ${totalFloatingProfitRate.toFixed(2)}%, 最高收益率: ${newHighestProfitRate.toFixed(2)}%`, {
                totalFloatingProfitRate: totalFloatingProfitRate.toFixed(2),
                totalFloatingProfit: totalFloatingProfit.toFixed(2),
                totalBenchmark: totalBenchmark.toFixed(2),
                total: total.toFixed(2),
                availableBalance: availableBalance.toFixed(2)
            });
            return { success: true, message: '进入回撤保护监控', action: 'START_MONITORING' };
        }
        return { success: true, message: '未达到触发条件', action: 'NO_ACTION' };

    } catch (error) {
        logger.error(`处理用户 ${userOption.userId} 的浮动盈利保护时出错:`, error);
        return { success: false, message: '处理浮动盈利保护时出错', error: error.message };
    }
}

/**
 * 处理浮动盈利保护（定时任务）
 * @returns {Promise<Object>} 处理结果
 */
export const handleFloatingProfitProtection = async () => {
    try {
        logger.info('开始处理浮动盈利保护（定时任务）');

        // 检查全局配置是否开启了浮动盈利保护
        const frontendSettings = await PageDataModel.findOne({ name: "frontendSettings" }).lean();
        const enableFloatingProfitProtection = frontendSettings?.data?.enableFloatingProfitProtection !== false;

        if (!enableFloatingProfitProtection) {
            logger.info('浮动盈利保护已全局关闭，跳过处理');
            return { success: true, message: '浮动盈利保护已全局关闭' };
        }

        // 查询所有活跃用户
        const allActiveUsers = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
            isProfitProtectionEnabled: true
        });

        if (allActiveUsers.length === 0) {
            logger.info('没有活跃用户，退出处理');
            return { success: true, message: '没有活跃用户' };
        }

        logger.info(`找到 ${allActiveUsers.length} 个活跃用户`);

        // 逐个处理每个用户
        const results = [];
        for (const userOption of allActiveUsers) {
            await handleUserFloatingProfitProtection(userOption);

        }

        return {
            success: true,
            message: '浮动盈利保护处理完成',
            data: results
        };
    } catch (error) {
        logger.error('处理浮动盈利保护时出错:', error);
        return { success: false, message: '处理浮动盈利保护时出错', error: error.message };
    }
};

/**
 * 启动定时任务
 */
export const startFloatingProfitProtectionScheduler = async () => {
    // 先加载配置
    await loadConfig();

    logger.info(`启动浮动盈利保护定时任务，间隔: ${CONFIG.MONITORING_INTERVAL / 1000 / 60} 分钟`);

    // 立即执行一次
    handleFloatingProfitProtection();

    // 设置定时任务
    setInterval(handleFloatingProfitProtection, CONFIG.MONITORING_INTERVAL);

    // 每5分钟重新加载一次配置，确保配置更改能及时生效
    setInterval(loadConfig, 5 * 60 * 1000);
};

/**
 * 手动触发浮动盈利保护检查
 * @param {Object} req - HTTP请求对象
 * @param {Object} res - HTTP响应对象
 * @returns {Promise<Object>}
 */
export const triggerFloatingProfitProtection = async (req, res) => {
    try {
        const result = await handleFloatingProfitProtection();
        return res.status(200).json(result);
    } catch (error) {
        logger.error('手动触发浮动盈利保护时出错:', error);
        return res.status(500).json({ success: false, message: '手动触发浮动盈利保护时出错', error: error.message });
    }
};
