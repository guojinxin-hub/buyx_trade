import {gateTrade, updateProtectionStopLoss as updateGateProtectionStopLoss} from "./gateTrade.js";
import {binanceTrade, updateProtectionStopLoss as updateBinanceProtectionStopLoss} from "./binanceTrade.js";
import {okxTrade} from "./okxTrade.js";

export const apiTrade = async ({tradeData, userOptions}) => {
    const {belong} = userOptions
    switch (belong) {
        case 'Gate':
            await gateTrade({tradeData, userOptions})
            break;
        case 'Binance':
            await binanceTrade({tradeData, userOptions})
            break;
        case 'OKX':
            await okxTrade({tradeData, userOptions})
            break;
        default:
            break;
    }
}

export const updateProtectionStopLoss = async (userOption, symbol, direction, protectionPrice, exchange, entryPrice) => {
    try {
        console.log(`更新保护止损单: 用户 ${userOption.userId}, 交易对 ${symbol}, 方向 ${direction}, 价格 ${protectionPrice}, 交易所 ${exchange}, 入场价 ${entryPrice}`);

        // 这里可以根据需要添加具体的实现逻辑
        // 例如，直接调用对应的交易所实现

        // 创建模拟的req和res对象
        const req = {
            body: {
                userOptions: userOption,
                symbol,
                direction,
                protectionPrice,
                entryPrice
            }
        };

        const res = {
            status: (code) => {
                return {
                    json: (data) => {
                        console.log('保护止损单更新响应:', data);
                        return data;
                    }
                };
            }
        };

        switch (exchange) {
            case 'gate':
                console.log('调用 Gate 交易所的保护止损更新');
                return await updateGateProtectionStopLoss(req, res);
            case 'binance':
                console.log('调用 Binance 交易所的保护止损更新');
                return await updateBinanceProtectionStopLoss(req, res);
            default:
                return {success: false, message: '不支持的交易所'};
        }
    } catch (error) {
        console.error('更新保护止损单出错:', error);
        return {success: false, message: '更新保护止损单出错', error: error.message};
    }
}

/**
 * 获取用户的持仓信息
 * @param {Object} userOption - 用户配置
 * @returns {Promise<Array>} 持仓信息列表
 */
export const getUserPositions = async (userOption) => {
    try {
        console.log(`获取用户 ${userOption.userId} 的持仓信息`);

        const {belong} = userOption;

        switch (belong) {
            case 'Gate':
                console.log('调用 Gate 交易所的持仓信息获取');
                // 导入 Gate 交易所的获取持仓函数
                const {getGatePositions} = await import('./gateTrade');
                return await getGatePositions(userOption);
            case 'Binance':
                console.log('调用 Binance 交易所的持仓信息获取');
                // 导入 Binance 交易所的获取持仓函数
                const {getBinancePositions} = await import('./binanceTrade');
                return await getBinancePositions(userOption);
            default:
                console.error('不支持的交易所:', belong);
                return [];
        }
    } catch (error) {
        console.error('获取用户持仓信息出错:', error);
        return [];
    }
};
