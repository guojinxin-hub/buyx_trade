import {postRecommendData} from "./trade/postRecommendData";
import {binanceTrade} from "../dataUtils/binanceTrade";
import {decrypt} from "../dataUtils/utils";
import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {isEmpty} from "lodash";
import {apiTrade} from "../dataUtils/apiTrade";
import {saveUserBalance} from "../dataUtils/saveUserBalance";
import {formatResponse} from "../dataUtils/formatResponse";

const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL
let client = new GateApi.ApiClient();

export const testAPI = async (req, res) => {
    try {
        const options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
            belong: "OKX"
        }).lean()
        console.log("options",options)
        for (const option of options) {
            if (!isEmpty(option)) {
                await apiTrade({userOptions: option, tradeData: [{symbol: "ETH", direction: "sell"}]})
            }
        }
        return formatResponse(res, 200, 0, {}, 'success')
        // testCode()
    } catch (e) {
        // console.log(e)
        res.status(500).json({error: e.message});
    }
}