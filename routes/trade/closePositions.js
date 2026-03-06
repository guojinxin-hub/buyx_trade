import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {isEmpty} from "lodash";
import {formatResponse} from "../../dataUtils/formatResponse";
import {executeClosePositions} from "../../dataUtils/closePositions";

export const closePositions = async (req, res) => {
    try {
        
        // 获取所有激活的用户交易配置
        const options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
            isClosePositionEnabled: true,
        }).lean();
        
        if (isEmpty(options)) {
            return formatResponse(res, 200, 0, {}, '没有激活的交易配置');
        }
        
        // 为每个用户执行平仓操作
        for (const option of options) {
            try {
                console.log(`为用户 ${option.userId} 执行平仓操作`);
                
                // 从TradeRecordModel中获取该用户的所有交易记录
                const tradeRecords = await TradeRecordModel.find({
                    userId: option.userId,
                    status: { $ne: 'closed' } // 只获取未平仓的交易
                }).lean();
                
                // 从交易记录中提取交易币种
                const symbols = [];
                for (const record of tradeRecords) {
                    if (record.symbol && !symbols.includes(record.symbol)) {
                        symbols.push(record.symbol);
                    }
                }
                
                // 创建交易数据
                const tradeData = symbols.map(symbol => ({symbol}));
                
                console.log(`为用户 ${option.userId} 获取到以下交易币种:`, symbols);
                
                // 执行平仓操作
                await executeClosePositions({tradeData, userOptions: option});
                
            } catch (error) {
                console.error(`为用户 ${option.userId} 执行平仓操作失败:`, error.message);
                // 继续处理下一个用户，不中断整个流程
            }
        }
        
        return formatResponse(res, 200, 0, {}, '平仓操作执行完成');
        
    } catch (error) {
        console.error('执行平仓操作失败:', error);
        return formatResponse(res, 500, 1, {}, '执行平仓操作失败');
    }
};
