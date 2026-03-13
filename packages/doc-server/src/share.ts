import type { Router } from 'express';
import { shareWebRoutes } from './share-web-routes.js';

export function createShareRouter(): Router {
  return shareWebRoutes;
}

export { shareWebRoutes };
