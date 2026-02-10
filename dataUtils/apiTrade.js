import {gateTrade, updateProtectionStopLoss as updateGateProtectionStopLoss} from "./gateTrade";
import {binanceTrade, updateProtectionStopLoss as updateBinanceProtectionStopLoss} from "./binanceTrade";
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";

export const apiTrade = async ({tradeData, userOptions}) => {
    const {belong} = userOptions
    switch (belong) {
        case 'Gate':
            await gateTrade({tradeData, userOptions})
            break;
        case 'Binance':
            await binanceTrade({tradeData, userOptions})
            break;
        default:
            break;
    }
}

export const updateProtectionStopLoss = async (userOption, symbol, direction, protectionPrice, exchange) => {
    try {
        console.log(`更新保护止损单: 用户 ${userOption.userId}, 交易对 ${symbol}, 方向 ${direction}, 价格 ${protectionPrice}, 交易所 ${exchange}`);
        
        // 这里可以根据需要添加具体的实现逻辑
        // 例如，直接调用对应的交易所实现
        
        // 创建模拟的req和res对象
        const req = {
            body: {
                userOptions: userOption,
                symbol,
                direction,
                protectionPrice
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
