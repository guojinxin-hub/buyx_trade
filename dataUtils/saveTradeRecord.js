// 保存用户的交易记录
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";

export const saveTradeRecord = async (userId, tradeData) => {
    const {
        symbol,
        price,
        size,
        direction,
        exchange,
        orderId,
        leverage,
        status
    } = tradeData;
    
    await TradeRecordModel.create({
        userId,
        symbol,
        price,
        size,
        direction,
        exchange,
        orderId,
        leverage,
        status
    });
};