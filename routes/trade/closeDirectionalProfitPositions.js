import { UserTradeOptionsModel } from "buydip_scheme/scheme/userTradeOptions";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { isEmpty } from "lodash";
import { formatResponse } from "../../dataUtils/formatResponse";
import { executeClosePositions } from "../../dataUtils/closePositions";
import { getUserPositions } from "../../dataUtils/apiTrade";

/**
 * 按方向平盈利单接口（规则3：闸门再次启动时，平掉反方向盈利单）
 *
 * 入参：{ direction: 'buy' | 'sell' }
 *   - direction='sell'：平掉所有【做空】且盈利的持仓（闸门启动做多时调用）
 *   - direction='buy'：平掉所有【做多】且盈利的持仓（闸门启动做空时调用）
 *
 * 业务逻辑：
 *   1. 获取所有激活用户的持仓
 *   2. 筛选「指定方向」且「盈利」的持仓
 *   3. 平仓并更新交易记录状态为 closed
 */
export const closeDirectionalProfitPositions = async (req, res) => {
    try {
        const { direction } = req.body || {};
        if (direction !== 'buy' && direction !== 'sell') {
            return formatResponse(res, 400, 1, {}, 'direction 参数必须为 buy 或 sell');
        }
        console.log(`开始执行按方向平盈利单操作，方向: ${direction}`);

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

        for (const option of options) {
            try {
                console.log(`为用户 ${option.userId} 执行按方向平盈利单操作，方向: ${direction}`);

                const userPositions = await getUserPositions(option);
                console.log(`用户 ${option.userId} 当前持仓数量：${userPositions.length}`);

                // 筛选指定方向且盈利的持仓
                const profitablePositions = userPositions.filter(pos => {
                    // 方向必须匹配
                    if (pos.direction !== direction) return false;

                    let pnl = 0;
                    if (pos.unrealisedPnl !== undefined) {
                        pnl = parseFloat(pos.unrealisedPnl) || 0;
                    } else {
                        const entryPrice = parseFloat(pos.entryPrice) || 0;
                        const currentPrice = parseFloat(pos.currentPrice) || 0;
                        if (entryPrice > 0 && currentPrice > 0) {
                            if (pos.direction === 'buy') {
                                pnl = (currentPrice - entryPrice) * pos.size;
                            } else {
                                pnl = (entryPrice - currentPrice) * Math.abs(pos.size);
                            }
                        }
                    }

                    console.log(`检查持仓 ${pos.symbol} (${pos.direction}) 盈亏：unrealisedPnl=${pos.unrealisedPnl}, pnl=${pnl}`);
                    return pnl > 0;
                });

                const tradeData = profitablePositions.map(pos => ({ symbol: pos.symbol }));

                console.log(`用户 ${option.userId} 的 ${direction} 方向盈利单：`, profitablePositions);

                if (isEmpty(tradeData)) {
                    console.log(`用户 ${option.userId} 没有需要平仓的 ${direction} 方向盈利单`);
                    continue;
                }

                await executeClosePositions({ tradeData, userOptions: option });
                totalClosedCount += tradeData.length;

                // 更新对应交易记录状态为 closed
                const symbolsToClose = tradeData.map(t => t.symbol);
                for (const symbol of symbolsToClose) {
                    const tradeRecords = await TradeRecordModel.find({
                        userId: option.userId,
                        symbol: symbol,
                        status: { $ne: 'closed' }
                    }).lean();

                    for (const record of tradeRecords) {
                        const position = profitablePositions.find(pos => pos.symbol === symbol);
                        if (position) {
                            const entryPrice = parseFloat(record.price) || 0;
                            const closePrice = parseFloat(position.currentPrice) || 0;
                            let profitRate = 0;

                            if (entryPrice > 0 && closePrice > 0) {
                                if (record.direction === 'buy') {
                                    profitRate = ((closePrice - entryPrice) / entryPrice) * 100;
                                } else {
                                    profitRate = ((entryPrice - closePrice) / entryPrice) * 100;
                                }
                            }

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
                console.error(`为用户 ${option.userId} 执行按方向平盈利单操作失败:`, error.message);
            }
        }

        console.log(`按方向平盈利单完成，共平仓 ${totalClosedCount} 个 ${direction} 方向盈利单`);
        return formatResponse(res, 200, 0, {
            closedCount: totalClosedCount
        }, `按方向平盈利单完成，已平掉 ${totalClosedCount} 个 ${direction} 方向盈利单`);

    } catch (error) {
        console.error('执行按方向平盈利单操作失败:', error);
        return formatResponse(res, 500, 1, {}, '执行按方向平盈利单操作失败');
    }
};
