import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRoutes } from './routes.js';
import { agentRoutes } from './agent-routes.js';
import { setupWebSocket } from './ws.js';
import { createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, startCollabRuntimeEmbedded } from './collab.js';
import { discoveryRoutes } from './discovery-routes.js';
import { shareWebRoutes } from './share-web-routes.js';
import {
  capabilitiesPayload,
  enforceApiClientCompatibility,
  enforceBridgeClientCompatibility,
} from './client-capabilities.js';
import { getBuildInfo } from './build-info.js';
import { homeRoutes } from './home-routes.js';
import { isShuttingDown, setShuttingDown } from './shutdown-state.js';
import { flushAllDocumentsForShutdown } from './collab.js';
import { getAuthStrategy } from './auth/index.js';
import { createAuthMiddleware } from './auth/middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '5555', 10);
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://localhost:5556',
  'http://127.0.0.1:5556',
  'http://localhost:5555',
  'http://127.0.0.1:5555',
  'null',
];

function parseAllowedCorsOrigins(): Set<string> {
  const configured = (process.env.PROOF_CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_CORS_ORIGINS);
}

async function main(): Promise<void> {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('error', (error) => {
    console.error('[server] WebSocketServer error (non-fatal):', error);
  });
  const allowedCorsOrigins = parseAllowedCorsOrigins();

  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    const originHeader = req.header('origin');
    if (originHeader && allowedCorsOrigins.has(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Content-Type',
        'Authorization',
        'X-Proof-Client-Version',
        'X-Proof-Client-Build',
        'X-Proof-Client-Protocol',
        'x-share-token',
        'x-bridge-token',
        'x-auth-poll-token',
        'X-Agent-Id',
        'X-Window-Id',
        'X-Document-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ].join(', '),
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Auth: mount strategy routes (login/callback/logout) and middleware.
  // Strategy is selected by PROOF_AUTH_STRATEGY env var ('none' or 'workos').
  const authStrategy = getAuthStrategy();
  app.use(authStrategy.router);
  app.use(createAuthMiddleware(authStrategy));

  // Home routes before static middleware so / serves the landing page,
  // not the SPA index.html that the build copies into public/.
  app.use(homeRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  app.use(express.static(path.join(__dirname, '..', 'dist'), { index: false }));

  app.get('/health', (_req, res) => {
    const buildInfo = getBuildInfo();
    res.json({
      ok: true,
      buildInfo,
      collab: getCollabRuntime(),
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(capabilitiesPayload());
  });

  app.use(discoveryRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  setupWebSocket(wss);
  await startCollabRuntimeEmbedded(PORT);

  const HOST = process.env.HOST || '0.0.0.0';
  server.listen(PORT, HOST, () => {
    console.log(`[proof-sdk] listening on http://${HOST}:${PORT}`);
  });

  // Graceful shutdown: drain HTTP connections, flush collab documents, then exit.
  const shutdown = async (signal: string) => {
    if (isShuttingDown()) return;
    setShuttingDown();
    console.log(`[proof-sdk] ${signal} received, shutting down…`);

    const forceTimeout = setTimeout(() => {
      console.error('[proof-sdk] shutdown timeout, forcing exit');
      process.exit(1);
    }, 10_000);
    forceTimeout.unref();

    let exitCode = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await flushAllDocumentsForShutdown();
    } catch (error) {
      console.error('[proof-sdk] error during shutdown flush', error);
      exitCode = 1;
    }
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[proof-sdk] failed to start server', error);
  process.exit(1);
});
