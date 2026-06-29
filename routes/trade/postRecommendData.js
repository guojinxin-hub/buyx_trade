import {UserTradeOptionsModel} from "buydip_scheme/scheme/userTradeOptions";
import {TradeRecordModel} from "buydip_scheme/scheme/tradeRecord";
import {isEmpty, orderBy} from "lodash";
import {FundFlowModel, OverallRecModel} from "buydip_scheme";
import moment from "moment";
import {formatResponse} from "../../dataUtils/formatResponse";
import {apiTrade} from "../../dataUtils/apiTrade";

export const postRecommendData = async (req, res) => {
    try {
        const {hour} = req.body
        const volumeData = await OverallRecModel.find({
            dateTime: hour,
            createdAt: {$gte: moment().startOf('day').toDate()}
        }).lean()
        console.log("hour",volumeData)

        const todaySymbol = volumeData.map((item) => {
            return item.symbol
        })
        const todayFunds = await FundFlowModel.find({
            symbol: {$in: todaySymbol},
            dateTime: Number(hour),
            date: moment().subtract(1, 'days').format('YYYY-MM-DD')
        }).lean()
        const todayTotalFunds = todayFunds.map(obj => ({
            ...obj,
            sum: Number(obj.inAmount) + Number(obj.outAmount)
        }));
        const sortTodayFunds = orderBy(todayTotalFunds, ["sum"], ['desc'])
        const symbolOrderMap = sortTodayFunds.reduce((map, obj, index) => {
            map[obj.symbol] = index;
            return map;
        }, {});

        const sortedArray = orderBy(volumeData, obj => symbolOrderMap[obj.symbol]);
        if (!isEmpty(sortedArray)) {
            const options = await UserTradeOptionsModel.find({
                isActive: true,
                isDelete: false,
            }).lean()
            for (const option of options) {
                if (!isEmpty(option)) {
                    const tradedSymbols = await TradeRecordModel.find({
                        userId: option._id,
                        createdAt: {$gte: moment().startOf('day').toDate()},
                    }).distinct('symbol');
                    
                    const filteredArray = sortedArray.filter(item => !tradedSymbols.includes(item.symbol));
                    console.log(`用户 ${option.userId} 今日已交易币种: ${tradedSymbols.join(', ') || '无'}，过滤后待交易: ${filteredArray.length}个`);
                    
                    if (!isEmpty(filteredArray)) {
                        await apiTrade({userOptions: option, tradeData: filteredArray})
                    } else {
                        console.log(`用户 ${option.userId} 今日已完成所有推荐币种的交易，跳过`);
                    }
                }
            }
        }
        return formatResponse(res, 200, 0, {}, 'success')
    } catch (e) {
        console.log(e, e.message)
    }
}