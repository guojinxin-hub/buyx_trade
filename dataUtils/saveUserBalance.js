// 保存用户的余额
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";

export const saveUserBalance = async (userId, accountFunds) => {
    const {total, unrealisedPnl, available} = accountFunds
    await UserTradeOptionsModel.findOneAndUpdate(
        {userId: userId},
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