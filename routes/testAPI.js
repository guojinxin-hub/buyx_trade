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
            maxVolume: "100",
            leverage: "2",
            stopLoss: "20",
            takeProfit: "20"
        })

return
            const client = new OKXClient({
                apiKey: '174e9b58-9d26-4867-b4d7-86b0d9135082',
                secretKey: '2B83F117884D7C04B5729ECD5C6588D5',
                passphrase: 'Ryan@cy00',
                isSimulated: true // 使用模拟盘
            });

            try {
                console.log("获取币种信息")
                const symbolsInfo = await client.getCurrencyInfo()
                console.log("symbolsInfo",symbolsInfo,symbolsInfo.length)
                return
                // 1. 获取账户余额
                console.log('获取账户余额...');
               // const balance = await client.getAccountBalance();
                console.log('账户余额:', JSON.stringify(balance, null, 2));

                // 2. 设置杠杆
                console.log('\n设置杠杆...');
                const leverage = await client.setLeverage('ETH-USDT-SWAP', 10);
                console.log('杠杆设置结果:', leverage);

                console.log("获取币种信息")
               // const symbolsInfo = await client.getCurrencyInfo('USDT')
                console.log("symbolsInfo",symbolsInfo)
                return
                // 3. 使用USDT金额下单（带止盈止损）
                console.log('\n使用USDT下单...');
                const order = await client.placeOrderWithUsdt({
                    instId: 'ETH-USDT-SWAP',
                    side: 'buy',
                    usdtAmount: 100,
                    attachAlgoOrds: {
                        tpOrdPx: 2500.00, // 止盈价
                        slTriggerPx: 2000.00, // 止损触发价
                        slOrdPx: -1, // -1表示市价止损
                        slTriggerPxType: 'last' // 最新价触发
                    }
                });
                console.log('下单结果:', order);

                // 4. 获取持仓
                console.log('\n获取持仓...');
                const positions = await client.getPositions();
                console.log('持仓:', JSON.stringify(positions, null, 2));

                // 5. 平仓
                // console.log('\n平仓...');
                // const closeResult = await client.closePosition('ETH-USDT-SWAP');
                // console.log('平仓结果:', closeResult);

            } catch (error) {
                console.error('错误:', error.message);
            }

    } catch (e) {
        res.status(500).json({error: e.message});
    }
}