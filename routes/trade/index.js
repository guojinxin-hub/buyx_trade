import express from "express";
import { postRecommendData } from "./postRecommendData";
import { updateProtectionStopLoss } from '../../dataUtils/gateTrade'
export const tradeRoute = express.Router();
tradeRoute.post('/postRecommendData', postRecommendData)

tradeRoute.post('/update-protection-stoploss', updateProtectionStopLoss)
