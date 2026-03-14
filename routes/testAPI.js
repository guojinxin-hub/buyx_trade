import { postRecommendData } from "./trade/postRecommendData";
import { binanceTrade } from "../dataUtils/binanceTrade";
import { decrypt } from "../dataUtils/utils";
import { UserTradeOptionsModel } from "buydip_scheme/scheme/userTradeOptions";
import { isEmpty } from "lodash";
import { apiTrade } from "../dataUtils/apiTrade";
import { saveUserBalance } from "../dataUtils/saveUserBalance";
import { formatResponse } from "../dataUtils/formatResponse";
const BinanceFuturesClient = require('../dataUtils/BinanceFutures/BinanceFuturesClient');
const GateApi = require('gate-api');
const TRADE_API_URL = process.env.TRADE_API_URL
const TRADE_TEST_API_URL = process.env.TRADE_TEST_API_URL
let client = new GateApi.ApiClient();

export const testAPI = async (req, res) => {
    try {
        // 创建BinanceFuturesClient实例
        // 注意: 你需要替换下面的API_KEY和API_SECRET为你自己的币安API密钥
        // 如果是测试网络，第三个参数设置为true
        const client = new BinanceFuturesClient(
            '8MpbjHooSkKxpt1BFHdFOlsHFTXzmGlLhcqiSuSlee2EkkBPS7kZeYySQNghezGU',    // 替换为你的API Key
            '6xYKIYOVVwPkH6nip6qJRawGKenxAzdq30rBZoGJIrYGFQLfsj238uvznVdIRXJs', // 替换为你的API Secret
            false              // 是否使用测试网络
        );

        // 测试获取BTCUSDT的挂单
        const symbol = 'ONDOUSDT';
        console.log(`正在获取 ${symbol} 的挂单...`);

        const openOrders = await client.getOpenOrders(symbol);
        console.log('挂单信息:', JSON.stringify(openOrders, null, 2));

        return formatResponse(res, 200, 0, openOrders, 'success');
        // testCode()
    } catch (e) {
        // console.log(e)
        res.status(500).json({ error: e.message });
    }
}