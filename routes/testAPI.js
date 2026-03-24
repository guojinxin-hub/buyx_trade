import { postRecommendData } from "./trade/postRecommendData";
import { binanceTrade } from "../dataUtils/binanceTrade";
import { decrypt } from "../dataUtils/utils";
import { UserTradeOptionsModel } from "buydip_scheme/scheme/userTradeOptions";
import { isEmpty } from "lodash";
import { apiTrade } from "../dataUtils/apiTrade";
import { saveUserBalance } from "../dataUtils/saveUserBalance";
import { formatResponse } from "../dataUtils/formatResponse";
import { executeGateClosePositions } from '../dataUtils/closePositions'
const BinanceFuturesClient = require('../dataUtils/BinanceFutures/BinanceFuturesClient');
const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL
let client = new GateApi.ApiClient();

export const testAPI = async (req, res) => {
    try {
        executeGateClosePositions({ userOptions: { apiKey:"U2FsdGVkX18a3sPkI5N4lGJlC6vgNe2O6JrQDGVh3XYz/cFQT8TioiGHmIXjwW6J1afp/kxtRURO1O5opSpRXA==", apiSecret:"U2FsdGVkX1//QntCloQ2MyLF3lLKxg7/WozpFesprbzZQsIBPpv0Eg+xpYn3hA6/cV4X6FiLhm1+sgpvkztlNwxVhTKdkVHLxeFE1RImavj5tlrFrH2A6lHDS5AhJ6BP", isTestOption:true } })

        return formatResponse(res, 200, 0, openOrders, 'success');
        // testCode()
    } catch (e) {
        // console.log(e)
        res.status(500).json({ error: e.message });
    }
}