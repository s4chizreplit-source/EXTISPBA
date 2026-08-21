import { areEngagementOrderWritesReady } from '../seeds/historicalOrderSeed.js';

export function createEngagementOrderReadinessMiddleware(
  isReady = areEngagementOrderWritesReady
) {
  return function requireEngagementOrderReadiness(_req, res, next) {
    if (!isReady()) {
      return res.status(503).json({
        error: 'Order system is finishing startup. Please retry shortly.',
      });
    }
    next();
  };
}

export const requireEngagementOrderReadiness =
  createEngagementOrderReadinessMiddleware();