import express from "express";
import { postRecommendData } from "./postRecommendData";
import { closePositions } from "./closePositions";
import { handleProfitProtection } from '../../dataUtils/profitProtection';
export const tradeRoute = express.Router();
tradeRoute.post('/postRecommendData', postRecommendData)
tradeRoute.post('/closePositions', closePositions)

tradeRoute.post('/update-protection-stoploss', handleProfitProtection);