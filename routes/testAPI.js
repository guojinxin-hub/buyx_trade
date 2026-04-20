import {postRecommendData} from "./trade/postRecommendData";
import {binanceTrade} from "../dataUtils/binanceTrade";
import {decrypt} from "../dataUtils/utils";
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {isEmpty} from "lodash";
import {apiTrade} from "../dataUtils/apiTrade";
import {saveUserBalance} from "../dataUtils/saveUserBalance";

const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL
let client = new GateApi.ApiClient();
import {okxTrade} from "../dataUtils/okxTrade";
import {OKXClient} from "../dataUtils/OKXFutures/OKXFuturesClient";
import {ObjectId} from "mongodb";

/**
 * 测试API接口
 * 用于测试Bitget带单交易功能
 * 
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @returns {Promise<void>}
 */
export const testAPI = async (req, res) => {
    try {
        // 步骤1: 查询用户的Bitget带单交易配置
        // 查询条件:
        // - isActive: true - 只查询激活的交易配置
        // - isDelete: false - 排除已删除的配置
        // - belong: "Bitget_Leader" - 只查询Bitget带单交易
        // - userId: 固定用户ID - 测试用户
        const options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
            belong: "Bitget_Leader",
            userId: new ObjectId("66440d6e8ddd8b3685baaf4b")
        }).lean()
        console.log("options", options)

        // 步骤2: 遍历每个交易配置并执行交易
        for (const option of options) {
            if (!isEmpty(option)) {
                // 调用apiTrade函数执行带单交易
                // 参数说明:
                // - userOptions: 用户交易配置，包含API密钥、交易参数等
                // - tradeData: 交易数据数组，包含symbol和direction
                //   - symbol: 'ETH' - 交易对符号
                //   - direction: 'sell' - 交易方向 (buy/sell)
                await apiTrade({
                    userOptions: option, 
                    tradeData: [{symbol: 'ETH', direction: 'sell'}]
                })
            }
        }

        // 步骤3: 返回成功响应
        res.status(200).json({message: "success"})
    } catch (e) {
        // 错误处理: 返回错误信息
        res.status(500).json({error: e.message});
    }
}