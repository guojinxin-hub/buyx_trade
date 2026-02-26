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

export const testAPI = async (req, res) => {
    try {
        const {apiKey, apiSecret, tradeData, userOptions} = req.body
        return await okxTrade([{symbol: 'ETH', direction: 'sell'}], {
            apiKey,
            apiSecret,
            direction: 'all',
            isTestOption: true,
            currency: ['BTC', 'ETH'],
            isActive: true,
            insurance: "200",
            maxVolume: "150",
            leverage: "2",
            stopLoss: "20",
            takeProfit: "20"
        })
        // testCode()
    } catch (e) {
        res.status(500).json({error: e.message});
    }
}