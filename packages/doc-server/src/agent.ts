import type { Router } from 'express';
import { agentRoutes } from './agent-routes.js';

export function createAgentRouter(): Router {
  return agentRoutes;
}

export { agentRoutes };
