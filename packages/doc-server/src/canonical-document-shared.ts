export {
  deriveProjectionFromCanonicalDoc,
  cloneFromCanonical,
  executeCanonicalRewrite,
  mutateCanonicalDocument,
  repairCanonicalProjection,
} from './canonical-document.js';

export type {
  CanonicalMutationResult,
  CanonicalRepairResult,
  CanonicalRouteResult,
} from './canonical-document.js';
