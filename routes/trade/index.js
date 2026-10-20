import express from "express";
import { postRecommendData } from "./postRecommendData";
import { closePositions } from "./closePositions";
import { closeReversePositions } from "./closeReversePositions";
import { closeDirectionalProfitPositions } from "./closeDirectionalProfitPositions";
import { closeAllPositions } from "./closeAllPositions";
import { syncPositions } from "./syncPositions";
import { handleProfitProtection } from '../../dataUtils/profitProtection';
import { triggerFloatingProfitProtection } from '../../dataUtils/floatingProfitProtection';
import { triggerBreakEvenProtection } from '../../dataUtils/breakEvenProtection';
import { triggerLimitEntryManager } from '../../dataUtils/limitEntryManager';
export const tradeRoute = express.Router();
tradeRoute.post('/postRecommendData', postRecommendData)
tradeRoute.post('/closePositions', closePositions)
tradeRoute.post('/closeReversePositions', closeReversePositions)
tradeRoute.post('/closeDirectionalProfitPositions', closeDirectionalProfitPositions)
tradeRoute.post('/closeAllPositions', closeAllPositions)
tradeRoute.post('/sync-positions', syncPositions)

tradeRoute.post('/update-protection-stoploss', handleProfitProtection);
tradeRoute.post('/trigger-floating-profit-protection', triggerFloatingProfitProtection);
tradeRoute.post('/trigger-break-even', triggerBreakEvenProtection);
tradeRoute.post('/trigger-limit-entry-manager', triggerLimitEntryManager);