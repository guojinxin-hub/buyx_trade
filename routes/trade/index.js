import express from "express";
import { postRecommendData } from "./postRecommendData";
import { handleProfitProtection } from '../../dataUtils/profitProtection';
export const tradeRoute = express.Router();
tradeRoute.post('/postRecommendData', postRecommendData)

tradeRoute.post('/update-protection-stoploss', handleProfitProtection);