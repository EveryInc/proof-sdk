import type { Router } from 'express';
import { shareWebRoutes } from '../../../server/share-web-routes.js';

export function createShareRouter(): Router {
  return shareWebRoutes;
}

export { shareWebRoutes };
