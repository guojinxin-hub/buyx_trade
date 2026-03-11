import { UserTradeOptionsModel } from "buydip_scheme/scheme/userTradeOptions";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { isEmpty } from "lodash";
import { formatResponse } from "../../dataUtils/formatResponse";
import { executeClosePositions } from "../../dataUtils/closePositions";
import { getUserPositions } from "../../dataUtils/apiTrade";

export const closePositions = async (req, res) => {
    try {
        console.log(`开始执行平仓操作`);

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

                // 获取用户当前持仓信息
                const userPositions = await getUserPositions(option);
                console.log(`用户 ${option.userId} 当前持仓:`, userPositions);

                // 筛选需要平仓的交易对
                let tradeData = [];

                // 只平盈利单（根据外部API获取的持仓信息）
                // 筛选盈利的持仓（unrealisedPnl > 0）
                const profitablePositions = userPositions.filter(pos => {
                    let pnl = 0;
                    
                    // 尝试从 API 返回的 unrealisedPnl 字段获取盈亏
                    if (pos.unrealisedPnl !== undefined) {
                        pnl = parseFloat(pos.unrealisedPnl) || 0;
                    } else {
                        const entryPrice = parseFloat(pos.entryPrice) || 0;
                        const currentPrice = parseFloat(pos.currentPrice) || 0;
                        
                        if (entryPrice > 0 && currentPrice > 0) {
                            if (pos.direction === 'buy') {
                                // 多单：当前价格 > 入场价格 为盈利
                                pnl = (currentPrice - entryPrice) * pos.size;
                            } else {
                                // 空单：当前价格 < 入场价格 为盈利
                                pnl = (entryPrice - currentPrice) * Math.abs(pos.size);
                            }
                        }
                    }
                    
                    console.log(`检查持仓 ${pos.symbol} 盈亏: unrealisedPnl=${pos.unrealisedPnl}, pnl=${pnl}`);
                    return pnl > 0;
                });

                tradeData = profitablePositions.map(pos => ({ symbol: pos.symbol }));

                console.log(`用户 ${option.userId} 的盈利单持仓:`, profitablePositions);
                console.log(`为用户 ${option.userId} 筛选出的平仓交易对:`, tradeData);

                if (isEmpty(tradeData)) {
                    console.log(`用户 ${option.userId} 没有需要平仓的交易`);
                    continue;
                }

                // 执行平仓操作
                await executeClosePositions({ tradeData, userOptions: option });

                // 更新对应交易记录状态为closed
                const symbolsToClose = tradeData.map(t => t.symbol);
                for (const symbol of symbolsToClose) {
                    await TradeRecordModel.updateMany(
                        {
                            userId: option.userId,
                            symbol: symbol,
                            status: { $ne: 'closed' }
                        },
                        {
                            $set: {
                                status: 'closed',
                                closeTime: new Date()
                            }
                        }
                    );
                    console.log(`已更新用户 ${option.userId} 交易对 ${symbol} 的交易记录状态为closed`);
                }

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
