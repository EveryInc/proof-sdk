import type { Router } from 'express';
import { agentRoutes } from '../../../server/agent-routes.js';

export function createAgentRouter(): Router {
  return agentRoutes;
}

export { agentRoutes };
