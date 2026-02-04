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

export const updateProtectionStopLoss = async (req, res) => {
    const {userId} = req.body;
    
    try {
        // 从数据库中查询用户的交易配置
        const userOptions = await UserTradeOptionsModel.findOne({userId: userId});
        
        if (!userOptions) {
            return res.status(404).json({success: false, message: '用户配置不存在'});
        }
        
        // 更新请求体中的userOptions
        req.body.userOptions = userOptions;
        
        const {belong} = userOptions;
        
        switch (belong) {
            case 'Gate':
                await updateGateProtectionStopLoss(req, res);
                break;
            case 'Binance':
                await updateBinanceProtectionStopLoss(req, res);
                break;
            default:
                return res.status(400).json({success: false, message: '不支持的交易所'});
        }
    } catch (error) {
        console.error('查询用户配置出错:', error);
        return res.status(500).json({success: false, message: '查询用户配置出错', error: error.message});
    }
}
