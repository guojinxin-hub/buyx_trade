// 保存用户的余额
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";

export const saveUserBalance = async (userId, accountFunds, belong) => {
    const {total, unrealisedPnl, available} = accountFunds
    // 必须按交易所定位配置文档：同一用户可有多个交易所配置，
    // 只按 userId 会写到"最新创建的那条"上，导致余额显示在错误的交易所配置里
    const query = belong ? {userId: userId, belong} : {userId: userId}
    await UserTradeOptionsModel.findOneAndUpdate(
        query,
        {
            accountFunds: {
                total, unrealisedPnl, available
            }
        },
        {
            upsert: true,
            new: true,
            sort: {createdAt: -1}
        })

}