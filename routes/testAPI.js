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
            belong: "Gate"
        }).lean()
        for (const option of options) {
            // if (!isEmpty(option)) {
            //     const {apiKey, apiSecret, isTestOption, currency} = option
            //     console.log(decrypt("U2FsdGVkX18AxYfDBjxnX/oVfkk8TGWT3/28BZnvW04sNW2RTBmGWxX0J4zsOPSbW80sgaSnd/qVYiSHBJlD3w=="),isTestOption)
            //     client.setApiKeySecret(decrypt("U2FsdGVkX18AxYfDBjxnX/oVfkk8TGWT3/28BZnvW04sNW2RTBmGWxX0J4zsOPSbW80sgaSnd/qVYiSHBJlD3w=="), decrypt("U2FsdGVkX1+HIBs+7a+pMwNx8Evev87z3fnC4/yepnVOefeLJEv/a7Z8KYe5I0aubykz9poeg8lbPSPW7Am1wW47OByAYcRVu9v8m4PIhFIsTAwJhkMizYwFuSjSc4R8"));
            //     client.basePath = isTestOption ? TRADE_TEST_API_URL : TRADE_API_URL
            //     const futuresApi = new GateApi.FuturesApi(client);
            //     const futureAccount = await futuresApi.listFuturesAccounts('usdt')
            //     console.log(futureAccount)
            //     saveUserBalance(option.userId, futureAccount.body)
            // }
        }
        return formatResponse(res, 200, 0, {}, 'success')
        // testCode()
    } catch (e) {
       // console.log(e)
        res.status(500).json({error: e.message});
    }
}