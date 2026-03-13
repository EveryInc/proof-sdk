export {
  deriveProjectionFromCanonicalDoc,
  cloneFromCanonical,
  executeCanonicalRewrite,
  mutateCanonicalDocument,
  repairCanonicalProjection,
} from '../../../server/canonical-document.js';

export type {
  CanonicalMutationResult,
  CanonicalRepairResult,
  CanonicalRouteResult,
} from '../../../server/canonical-document.js';
