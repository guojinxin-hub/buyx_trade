import express from "express";
import { postRecommendData } from "./postRecommendData";
import { updateProtectionStopLoss } from '../../dataUtils/apiTrade'
export const tradeRoute = express.Router();
tradeRoute.post('/postRecommendData', postRecommendData)

tradeRoute.post('/update-protection-stoploss', updateProtectionStopLoss)
