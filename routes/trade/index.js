import express from "express";
import { postRecommendData } from "./postRecommendData";
import { closePositions } from "./closePositions";
import { closeReversePositions } from "./closeReversePositions";
import { closeAllPositions } from "./closeAllPositions";
import { syncPositions } from "./syncPositions";
import { handleProfitProtection } from '../../dataUtils/profitProtection';
import { triggerFloatingProfitProtection } from '../../dataUtils/floatingProfitProtection';
import { triggerBreakEvenProtection } from '../../dataUtils/breakEvenProtection';
import { vadmaOpen, vadmaClose, vadmaUpdateStop, vadmaPositions } from "./vadmaTrade";
export const tradeRoute = express.Router();
tradeRoute.post('/postRecommendData', postRecommendData)
tradeRoute.post('/closePositions', closePositions)
tradeRoute.post('/closeReversePositions', closeReversePositions)
tradeRoute.post('/closeAllPositions', closeAllPositions)
tradeRoute.post('/sync-positions', syncPositions)

tradeRoute.post('/update-protection-stoploss', handleProfitProtection);
tradeRoute.post('/trigger-floating-profit-protection', triggerFloatingProfitProtection);
tradeRoute.post('/trigger-break-even', triggerBreakEvenProtection);

// VADMA 策略交易接口
tradeRoute.post('/vadma/open', vadmaOpen)
tradeRoute.post('/vadma/close', vadmaClose)
tradeRoute.post('/vadma/update-stop', vadmaUpdateStop)
tradeRoute.post('/vadma/positions', vadmaPositions)