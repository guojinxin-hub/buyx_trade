/**
 * 用户持仓同步接口
 *
 * 业务逻辑：
 * 1. 获取所有激活的用户交易配置
 * 2. 调用各交易所 API 获取实时持仓
 * 3. 将持仓信息存入 UserPositionModel 表
 * 4. 清理已无持仓的旧记录
 *
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @returns {Promise<void>}
 */
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {UserPositionModel} from "buydip_scheme";
import {isEmpty} from "lodash";
import moment from "moment";
import {formatResponse} from "../../dataUtils/formatResponse";
import {getUserPositions} from "../../dataUtils/apiTrade";

export const syncPositions = async (req, res) => {
    try {
        console.log("开始同步用户持仓...");

        // 1. 获取所有激活的用户交易配置
        const options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
        }).lean();

        if (isEmpty(options)) {
            return formatResponse(res, 200, 0, {}, '没有激活的交易配置');
        }

        let totalSynced = 0;
        const seenKeys = new Set(); // 本次同步到的持仓唯一键

        // 2. 遍历每个用户获取持仓
        for (const option of options) {
            try {
                const positions = await getUserPositions(option);
                if (isEmpty(positions)) {
                    console.log(`用户 ${option.userId}（${option.belong}）无持仓`);
                    continue;
                }

                for (const pos of positions) {
                    const key = `${option.userId}_${option.belong}_${pos.symbol}`;
                    seenKeys.add(key);

                    // 3. 存入 UserPositionModel（保留已有的 cciReady 状态）
                    const filter = {
                        userId: option.userId,
                        exchange: option.belong,
                        symbol: pos.symbol
                    };

                    const existing = await UserPositionModel.findOne(filter).lean();

                    await UserPositionModel.updateOne(
                        filter,
                        {
                            $set: {
                                direction: pos.direction,
                                entryPrice: String(pos.entryPrice || ""),
                                size: String(pos.size || ""),
                                currentPrice: String(pos.currentPrice || pos.markPrice || ""),
                                unrealisedPnl: Number(pos.unrealisedPnl) || 0,
                                leverage: String(pos.leverage || "1"),
                                cciValue: existing?.cciValue ?? null,
                            }
                        },
                        {upsert: true}
                    );
                    totalSynced++;
                }

                console.log(`用户 ${option.userId}（${option.belong}）同步 ${positions.length} 个持仓`);
            } catch (error) {
                console.error(`获取用户 ${option.userId}（${option.belong}）持仓失败:`, error.message);
            }
        }

        // 4. 清理本次未同步到的记录（持仓已平仓）
        const allPositions = await UserPositionModel.find({}).lean();
        const staleIds = allPositions
            .filter(p => !seenKeys.has(`${p.userId}_${p.exchange}_${p.symbol}`))
            .map(p => p._id);

        if (!isEmpty(staleIds)) {
            await UserPositionModel.deleteMany({_id: {$in: staleIds}});
            console.log(`清理 ${staleIds.length} 条过期持仓记录`);
        }

        console.log(`持仓同步完成，共同步 ${totalSynced} 条持仓`);
        return formatResponse(res, 200, 0, {total: totalSynced}, '持仓同步完成');
    } catch (e) {
        console.error("同步用户持仓失败:", e.message);
        return formatResponse(res, 500, 1, {}, '服务器错误');
    }
};
