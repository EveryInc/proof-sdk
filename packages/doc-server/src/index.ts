import type { Express, Router } from 'express';
import { agentRoutes } from './agent.js';
import { bridgeRouter, createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, startCollabRuntime, startCollabRuntimeEmbedded } from './collab.js';
import { apiRoutes, handleShareMarkdown, shareMarkdownBodyParser } from './documents.js';
import { shareWebRoutes } from './share.js';

export function createDocumentRouter(): Router {
  return apiRoutes;
}

export function createShareRouter(): Router {
  return shareWebRoutes;
}

export function createAgentRouter(): Router {
  return agentRoutes;
}

export function createBridgeRouter(): Router {
  return bridgeRouter;
}

export function createCollabRuntime() {
  return getCollabRuntime();
}

export function mountProofSdkRoutes(app: Express): void {
  app.use(apiRoutes);
  app.use('/documents', createBridgeMountRouter());
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);
}

export {
  agentRoutes,
  apiRoutes,
  bridgeRouter,
  getCollabRuntime,
  handleShareMarkdown,
  shareMarkdownBodyParser,
  shareWebRoutes,
  startCollabRuntime,
  startCollabRuntimeEmbedded,
};
