import type { Router } from 'express';
import { bridgeRouter, createBridgeMountRouter } from '../../../server/bridge.js';

export function createBridgeRouter(): Router {
  return bridgeRouter;
}

export { bridgeRouter, createBridgeMountRouter };
