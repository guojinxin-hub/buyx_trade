import { UserTradeOptionsModel } from "buydip_scheme/scheme/userTradeOptions";
import { TradeRecordModel } from "buydip_scheme/scheme/tradeRecord";
import { isEmpty } from "lodash";
import { formatResponse } from "../../dataUtils/formatResponse";
import { executeClosePositions } from "../../dataUtils/closePositions";
import { getUserPositions } from "../../dataUtils/apiTrade";

export const closePositions = async (req, res) => {
    try {
        console.log(`开始执行平仓操作`);

        // CCI 平仓模式：传入 targetSymbols 时按指定币种+方向平仓（不过滤盈利）
        const { targetSymbols } = req.body || {};
        const isCCIMode = !isEmpty(targetSymbols);

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
                let profitablePositions = [];

                if (isCCIMode) {
                    // CCI 平仓模式：按指定币种+方向平仓，不过滤盈利
                    profitablePositions = userPositions.filter(pos => {
                        return targetSymbols.some(t => t.symbol === pos.symbol && t.direction === pos.direction);
                    });
                    tradeData = profitablePositions.map(pos => ({ symbol: pos.symbol }));
                    console.log(`用户 ${option.userId} CCI平仓目标:`, tradeData);
                } else {
                    // 只平盈利单（根据外部API获取的持仓信息）
                    // 筛选盈利的持仓（unrealisedPnl > 0）
                    profitablePositions = userPositions.filter(pos => {
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
                }

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
                    // 先查询需要平仓的交易记录
                    const tradeRecords = await TradeRecordModel.find({
                        userId: option.userId,
                        symbol: symbol,
                        status: { $ne: 'closed' }
                    }).lean();
                    
                    // 为每个交易记录计算收益率并更新
                    for (const record of tradeRecords) {
                        // 找到对应的持仓信息以获取平仓价格
                        const position = profitablePositions.find(pos => pos.symbol === symbol);
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
