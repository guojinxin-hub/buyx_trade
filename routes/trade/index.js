import express from "express";
import { postRecommendData } from "./postRecommendData";
import { closePositions } from "./closePositions";
import { closeReversePositions } from "./closeReversePositions";
import { closeAllPositions } from "./closeAllPositions";
import { handleProfitProtection } from '../../dataUtils/profitProtection';
import { triggerFloatingProfitProtection } from '../../dataUtils/floatingProfitProtection';
export const tradeRoute = express.Router();
tradeRoute.post('/postRecommendData', postRecommendData)
tradeRoute.post('/closePositions', closePositions)
tradeRoute.post('/closeReversePositions', closeReversePositions)
tradeRoute.post('/closeAllPositions', closeAllPositions)

tradeRoute.post('/update-protection-stoploss', handleProfitProtection);
tradeRoute.post('/trigger-floating-profit-protection', triggerFloatingProfitProtection);