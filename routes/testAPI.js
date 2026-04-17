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

export const testAPI = async (req, res) => {
    try {
        const options = await UserTradeOptionsModel.find({
            isActive: true,
            isDelete: false,
            belong: "Gate",
            userId: new ObjectId("674136979736309d67fd1e3c")
        }).lean()
        console.log("options", options)
        for (const option of options) {
            if (!isEmpty(option)) {
                await apiTrade({userOptions: option, tradeData: [{symbol: 'AAVE', direction: 'sell'}]})
            }
        }
        res.status(200).json({message: "success"})
    } catch (e) {
        res.status(500).json({error: e.message});
    }
}