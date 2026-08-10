/**
 * VADMA 策略交易执行接口
 *
 * 接收 buydip_engine VADMA 引擎的开仓/平仓/更新止损/查询持仓请求
 * 针对指定 userId 的 UserTradeOptionsModel 配置执行实际交易所操作
 *
 * 端点：
 * - POST /vadma/open        开仓（市价单 + ATR止损单）
 * - POST /vadma/close       平仓（市价平仓）
 * - POST /vadma/update-stop 更新止损价（清除旧止损单 + 挂新止损单）
 * - POST /vadma/positions   查询用户当前持仓
 */
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {ObjectId} from "mongodb";
import {isEmpty} from "lodash";
import {apiTrade, getUserPositions, updateProtectionStopLoss} from "../../dataUtils/apiTrade";
import {executeClosePositions} from "../../dataUtils/closePositions";
import {formatResponse} from "../../dataUtils/formatResponse";

/**
 * 查询目标用户的激活交易配置
 */
const getUserOption = async (userId) => {
    return await UserTradeOptionsModel.findOne({
        userId: new ObjectId(userId),
        isActive: true,
        isDelete: false,
    }).lean();
};

/**
 * 开仓接口
 * POST /vadma/open
 * Body: { userId, symbol, direction }
 */
export const vadmaOpen = async (req, res) => {
    try {
        const {userId, symbol, direction} = req.body;

        if (!userId || !symbol || !direction) {
            return formatResponse(res, 400, 1, {}, "参数缺失: userId, symbol, direction 必填");
        }

        const userOptions = await getUserOption(userId);
        if (isEmpty(userOptions)) {
            return formatResponse(res, 404, 1, {}, "未找到激活的交易配置");
        }

        // 调用 apiTrade 下单（tradeData 只需 symbol + direction）
        // gateTrade 内部会处理：无持仓→开仓，反方向→反手，同方向→跳过
        await apiTrade({
            userOptions,
            tradeData: [{symbol, direction}],
        });

        // 查询实际持仓获取成交价（市价单成交后持仓即反映入场价）
        let fillPrice = 0;
        try {
            const positions = await getUserPositions(userOptions);
            const pos = positions.find(p => p.symbol === symbol && parseFloat(p.size) !== 0);
            if (pos) {
                fillPrice = Number(pos.entryPrice) || 0;
            }
        } catch (e) {
            console.warn(`[VADMA-Trade] 获取持仓信息失败:`, e.message);
        }

        console.log(`[VADMA-Trade] 开仓完成: 用户=${userId}, ${symbol} ${direction}, 成交价=${fillPrice}`);
        return formatResponse(res, 200, 0, {symbol, direction, fillPrice, success: true}, "开仓指令已执行");
    } catch (error) {
        console.error(`[VADMA-Trade] 开仓失败:`, error.message);
        return formatResponse(res, 500, 1, {success: false}, `开仓失败: ${error.message}`);
    }
};

/**
 * 平仓接口
 * POST /vadma/close
 * Body: { userId, symbol }
 */
export const vadmaClose = async (req, res) => {
    try {
        const {userId, symbol} = req.body;

        if (!userId || !symbol) {
            return formatResponse(res, 400, 1, {}, "参数缺失: userId, symbol 必填");
        }

        const userOptions = await getUserOption(userId);
        if (isEmpty(userOptions)) {
            return formatResponse(res, 404, 1, {}, "未找到激活的交易配置");
        }

        // 执行平仓
        await executeClosePositions({
            tradeData: [{symbol}],
            userOptions,
        });

        console.log(`[VADMA-Trade] 平仓完成: 用户=${userId}, ${symbol}`);
        return formatResponse(res, 200, 0, {symbol}, "平仓指令已执行");
    } catch (error) {
        console.error(`[VADMA-Trade] 平仓失败:`, error.message);
        return formatResponse(res, 500, 1, {}, `平仓失败: ${error.message}`);
    }
};

/**
 * 更新止损价接口
 * POST /vadma/update-stop
 * Body: { userId, symbol, direction, stopPrice }
 */
export const vadmaUpdateStop = async (req, res) => {
    try {
        const {userId, symbol, direction, stopPrice} = req.body;

        if (!userId || !symbol || !direction || !stopPrice) {
            return formatResponse(res, 400, 1, {}, "参数缺失: userId, symbol, direction, stopPrice 必填");
        }

        const userOptions = await getUserOption(userId);
        if (isEmpty(userOptions)) {
            return formatResponse(res, 404, 1, {}, "未找到激活的交易配置");
        }

        // 调用 updateProtectionStopLoss 更新交易所止损单
        await updateProtectionStopLoss(
            userOptions,
            symbol,
            direction,
            stopPrice,
            userOptions.belong.toLowerCase(),
            null
        );

        console.log(`[VADMA-Trade] 止损更新: 用户=${userId}, ${symbol} ${direction} 止损=${stopPrice}`);
        return formatResponse(res, 200, 0, {symbol, direction, stopPrice}, "止损单已更新");
    } catch (error) {
        console.error(`[VADMA-Trade] 更新止损失败:`, error.message);
        return formatResponse(res, 500, 1, {}, `更新止损失败: ${error.message}`);
    }
};

/**
 * 查询用户持仓接口
 * POST /vadma/positions
 * Body: { userId }
 */
export const vadmaPositions = async (req, res) => {
    try {
        const {userId} = req.body;

        if (!userId) {
            return formatResponse(res, 400, 1, {}, "参数缺失: userId 必填");
        }

        const userOptions = await getUserOption(userId);
        if (isEmpty(userOptions)) {
            return formatResponse(res, 404, 1, {}, "未找到激活的交易配置");
        }

        const positions = await getUserPositions(userOptions);

        return formatResponse(res, 200, 0, {positions}, "查询成功");
    } catch (error) {
        console.error(`[VADMA-Trade] 查询持仓失败:`, error.message);
        return formatResponse(res, 500, 1, {}, `查询持仓失败: ${error.message}`);
    }
};
