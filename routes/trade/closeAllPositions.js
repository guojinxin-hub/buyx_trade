import { UserTradeOptionsModel } from "buydip_scheme/scheme/userTradeOptions";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { PageDataModel } from "buydip_scheme";
import { isEmpty } from "lodash";
import { formatResponse } from "../../dataUtils/formatResponse";
import { executeClosePositions } from "../../dataUtils/closePositions";
import { getUserPositions } from "../../dataUtils/apiTrade";

/**
 * 全部平仓接口
 * 判断用户账户整体是否盈利，如果盈利则平仓所有单子，否则不平仓
 * 
 * 业务逻辑：
 * 1. 获取所有用户的持仓
 * 2. 计算用户账户整体盈亏（所有持仓的未实现盈亏之和）
 * 3. 如果整体盈利（总盈亏 > 0），则平仓所有持仓
 * 4. 如果整体亏损或持平（总盈亏 <= 0），则不平仓
 * 5. 更新交易记录状态为 closed
 */
export const closeAllPositions = async (req, res) => {
    try {
        console.log(`开始执行全部平仓操作`);

        // 获取所有激活的用户交易配置
        const options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
            isClosePositionEnabled: true,
        }).lean();

        if (isEmpty(options)) {
            return formatResponse(res, 200, 0, {}, '没有激活的交易配置');
        }

        let totalClosedCount = 0;

        // 为每个用户执行平仓操作
        for (const option of options) {
            try {
                console.log(`为用户 ${option.userId} 执行全部平仓操作`);

                // 获取用户当前持仓信息
                const userPositions = await getUserPositions(option);
                console.log(`用户 ${option.userId} 当前持仓数量：${userPositions.length}`);

                // 筛选有持仓的单子
                const positionsWithSize = userPositions.filter(pos => {
                    const size = parseFloat(pos.size) || 0;
                    return size !== 0;
                });

                if (isEmpty(positionsWithSize)) {
                    console.log(`用户 ${option.userId} 没有持仓`);
                    continue;
                }

                // 计算账户整体盈亏（所有持仓的绝对盈亏之和）
                const totalAbsolutePnl = positionsWithSize.reduce((sum, pos) => {
                    return sum + (parseFloat(pos.absolutePnl) || 0);
                }, 0);

                console.log(`用户 ${option.userId} 账户整体盈亏：${totalAbsolutePnl.toFixed(2)} USDT`);

                // 如果账户整体盈利小于等于10美金，则不平仓
                if (totalAbsolutePnl <= 10) {
                    console.log(`用户 ${option.userId} 账户整体盈利不足10美金（${totalAbsolutePnl.toFixed(2)} USDT），不平仓`);
                    continue;
                }

                // 如果账户整体盈利大于10美金，则平仓所有持仓
                const tradeData = positionsWithSize.map(pos => ({ symbol: pos.symbol }));
                console.log(`用户 ${option.userId} 账户整体盈利超过10美金（${totalAbsolutePnl.toFixed(2)} USDT），执行全部平仓`);
                console.log(`为用户 ${option.userId} 筛选出的平仓交易对：`, tradeData);

                // 执行平仓操作
                await executeClosePositions({ tradeData, userOptions: option });
                totalClosedCount += tradeData.length;

                // 更新对应交易记录状态为 closed
                const symbolsToClose = tradeData.map(t => t.symbol);
                for (const symbol of symbolsToClose) {
                    // 先查询需要平仓的交易记录
                    const tradeRecords = await TradeRecordModel.find({
                        userId: option.userId,
                        symbol: symbol,
                        status: { $ne: 'closed' }
                    }).lean();
                    
                    // 为每个交易记录计算收益率并更新
                    for (const record of tradeRecords) {
                        // 找到对应的持仓信息以获取平仓价格
                        const position = positionsWithSize.find(pos => pos.symbol === symbol);
                        if (position) {
                            const entryPrice = parseFloat(record.price) || 0;
                            const closePrice = parseFloat(position.currentPrice) || 0;
                            let profitRate = 0;
                            
                            if (entryPrice > 0 && closePrice > 0) {
                                if (record.direction === 'buy') {
                                    // 多单：(平仓价格 - 入场价格) / 入场价格
                                    profitRate = ((closePrice - entryPrice) / entryPrice) * 100;
                                } else {
                                    // 空单：(入场价格 - 平仓价格) / 入场价格
                                    profitRate = ((entryPrice - closePrice) / entryPrice) * 100;
                                }
                            }
                            
                            // 更新交易记录
                            await TradeRecordModel.updateOne(
                                { _id: record._id },
                                {
                                    $set: {
                                        status: 'closed',
                                        closeTime: new Date(),
                                        closePrice: closePrice.toString(),
                                        profitRate: profitRate.toFixed(2).toString()
                                    }
                                }
                            );
                        }
                    }
                    console.log(`已更新用户 ${option.userId} 交易对 ${symbol} 的交易记录状态为 closed`);
                }

            } catch (error) {
                console.error(`为用户 ${option.userId} 执行全部平仓操作失败:`, error.message);
                // 继续处理下一个用户，不中断整个流程
            }
        }

        console.log(`全部平仓操作完成，共平仓 ${totalClosedCount} 个持仓`);
        return formatResponse(res, 200, 0, { 
            closedCount: totalClosedCount
        }, `全部平仓操作完成，已平掉 ${totalClosedCount} 个持仓`);

    } catch (error) {
        console.error('执行全部平仓操作失败:', error);
        return formatResponse(res, 500, 1, {}, '执行全部平仓操作失败');
    }
};