import type { Express, Router } from 'express';
import { agentRoutes, createAgentRouter } from './agent.js';
import { bridgeRouter, createBridgeMountRouter, createBridgeRouter } from './bridge.js';
import { createCollabRuntime, getCollabRuntime, startCollabRuntime, startCollabRuntimeEmbedded } from './collab.js';
import { apiRoutes, createDocumentRouter, handleShareMarkdown, shareMarkdownBodyParser } from './documents.js';
import { createShareRouter, shareWebRoutes } from './share.js';

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
  createAgentRouter,
  createBridgeRouter,
  createCollabRuntime,
  createDocumentRouter,
  createShareRouter,
  getCollabRuntime,
  handleShareMarkdown,
  shareMarkdownBodyParser,
  shareWebRoutes,
  startCollabRuntime,
  startCollabRuntimeEmbedded,
};
