import { getCollabRuntime, startCollabRuntime, startCollabRuntimeEmbedded } from '../../../server/collab.js';

export {
  startCollabRuntime,
  startCollabRuntimeEmbedded,
};

export function createCollabRuntime() {
  return getCollabRuntime();
}

export { getCollabRuntime };
