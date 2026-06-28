import { UserTradeOptionsModel } from "buydip_scheme/scheme/userTradeOptions";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { PageDataModel } from "buydip_scheme";
import { isEmpty } from "lodash";
import { formatResponse } from "../../dataUtils/formatResponse";
import { executeClosePositions } from "../../dataUtils/closePositions";
import { getUserPositions } from "../../dataUtils/apiTrade";

/**
 * 智能反向平仓接口
 * 根据推荐方向，平掉反向的盈利单
 * 
 * 业务逻辑：
 * 1. 先判断账户整体是否盈利，如果未盈利则不平仓
 * 2. 如果推荐的是空信号 (sell)，检查持仓内是否有多单盈利，先平仓盈利多单后，再入场空单
 * 3. 如果推荐的是多信号 (buy)，检查持仓内是否有空单盈利，先平仓盈利空单后，再入场多单
 * 4. 每次推荐都触发此逻辑，而且是优先触发
 * 
 * 推荐方向从数据库获取（LAST_RECOMMEND_DIRECTION）
 */
export const closeReversePositions = async (req, res) => {
    try {
        // 从数据库获取推荐方向
        const lastDirectionData = await PageDataModel.findOne({ name: "LAST_RECOMMEND_DIRECTION" }).lean();
        const direction = lastDirectionData?.data || null;

        // 验证推荐方向
        if (!direction || !['buy', 'sell'].includes(direction)) {
            return formatResponse(res, 400, 1, {}, '数据库中推荐方向为空或无效');
        }

        console.log(`开始执行智能反向平仓，推荐方向：${direction}`);

        // 确定需要平仓的反向单方向
        const reverseDirection = direction === 'buy' ? 'sell' : 'buy';
        console.log(`需要平仓的反向单方向：${reverseDirection}`);

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
                console.log(`为用户 ${option.userId} 执行反向平仓操作，推荐方向：${direction}`);

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

                // 筛选反向方向的持仓
                const reversePositions = userPositions.filter(pos => {
                    // 判断持仓方向是否为反向
                    const isReverseDirection = pos.direction === reverseDirection;
                    if (!isReverseDirection) {
                        return false;
                    }

                    // 计算盈亏
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
                    
                    console.log(`检查反向持仓 ${pos.symbol} (${pos.direction}) 盈亏：unrealisedPnl=${pos.unrealisedPnl}, pnl=${pnl}`);
                    
                    // 只平仓盈利单
                    return pnl > 0;
                });

                const tradeData = reversePositions.map(pos => ({ symbol: pos.symbol }));

                console.log(`用户 ${option.userId} 的反向盈利单持仓：`, reversePositions);
                console.log(`为用户 ${option.userId} 筛选出的平仓交易对：`, tradeData);

                if (isEmpty(tradeData)) {
                    console.log(`用户 ${option.userId} 没有需要平仓的${reverseDirection}盈利单`);
                    continue;
                }

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
                        direction: reverseDirection,
                        status: { $ne: 'closed' }
                    }).lean();
                    
                    // 为每个交易记录计算收益率并更新
                    for (const record of tradeRecords) {
                        // 找到对应的持仓信息以获取平仓价格
                        const position = reversePositions.find(pos => pos.symbol === symbol);
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
                    console.log(`已更新用户 ${option.userId} 交易对 ${symbol} 的${reverseDirection}单记录状态为 closed`);
                }

            } catch (error) {
                console.error(`为用户 ${option.userId} 执行反向平仓操作失败:`, error.message);
                // 继续处理下一个用户，不中断整个流程
            }
        }

        console.log(`智能反向平仓完成，推荐方向：${direction}, 共平仓 ${totalClosedCount} 个反向盈利单`);
        return formatResponse(res, 200, 0, { 
            closedCount: totalClosedCount,
            direction: direction,
            reverseDirection: reverseDirection
        }, `智能反向平仓完成，已平掉 ${totalClosedCount} 个${reverseDirection}盈利单`);

    } catch (error) {
        console.error('执行智能反向平仓操作失败:', error);
        return formatResponse(res, 500, 1, {}, '执行智能反向平仓操作失败');
    }
};
