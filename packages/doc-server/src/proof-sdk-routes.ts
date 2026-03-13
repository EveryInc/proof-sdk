import { canonicalCreateHref, canonicalCreateLink, AGENT_DOCS_PATH } from './agent-guidance.js';

function withOrigin(path: string, origin?: string): string {
  if (!origin) return path;
  return `${origin}${path}`;
}

export interface ProofSdkDocumentPaths {
  create: string;
  document: string;
  title: string;
  state: string;
  snapshot: string;
  edit: string;
  editV2: string;
  ops: string;
  presence: string;
  events: string;
  eventsPending: string;
  eventsAck: string;
  bridgeBase: string;
  bridgeState: string;
  bridgeMarks: string;
  bridgeComments: string;
  bridgeSuggestions: string;
  bridgeRewrite: string;
  bridgePresence: string;
  docs: string;
}

export interface ProofSdkRouteOptions {
  origin?: string;
  includeMutationRoutes?: boolean;
  includeSnapshotRoute?: boolean;
  includeEditV2Route?: boolean;
  includeBridgeRoutes?: boolean;
}

export function buildProofSdkDocumentPaths(slug: string, origin?: string): ProofSdkDocumentPaths {
  const encodedSlug = encodeURIComponent(slug);
  const base = `/documents/${encodedSlug}`;
  return {
    create: canonicalCreateHref(origin),
    document: withOrigin(base, origin),
    title: withOrigin(`${base}/title`, origin),
    state: withOrigin(`${base}/state`, origin),
    snapshot: withOrigin(`${base}/snapshot`, origin),
    edit: withOrigin(`${base}/edit`, origin),
    editV2: withOrigin(`${base}/edit/v2`, origin),
    ops: withOrigin(`${base}/ops`, origin),
    presence: withOrigin(`${base}/presence`, origin),
    events: withOrigin(`${base}/events/pending`, origin),
    eventsPending: withOrigin(`${base}/events/pending?after=0`, origin),
    eventsAck: withOrigin(`${base}/events/ack`, origin),
    bridgeBase: withOrigin(`${base}/bridge`, origin),
    bridgeState: withOrigin(`${base}/bridge/state`, origin),
    bridgeMarks: withOrigin(`${base}/bridge/marks`, origin),
    bridgeComments: withOrigin(`${base}/bridge/comments`, origin),
    bridgeSuggestions: withOrigin(`${base}/bridge/suggestions`, origin),
    bridgeRewrite: withOrigin(`${base}/bridge/rewrite`, origin),
    bridgePresence: withOrigin(`${base}/bridge/presence`, origin),
    docs: withOrigin(AGENT_DOCS_PATH, origin),
  };
}

export function buildProofSdkLinks(
  slug: string,
  {
    origin,
    includeMutationRoutes = true,
    includeSnapshotRoute = false,
    includeEditV2Route = false,
    includeBridgeRoutes = false,
  }: ProofSdkRouteOptions = {},
): Record<string, unknown> {
  const paths = buildProofSdkDocumentPaths(slug, origin);
  const links: Record<string, unknown> = {
    create: canonicalCreateLink(origin),
    state: paths.state,
    presence: { method: 'POST', href: paths.presence },
    events: paths.eventsPending,
    docs: paths.docs,
  };
  if (includeMutationRoutes) {
    links.ops = { method: 'POST', href: paths.ops };
    links.edit = { method: 'POST', href: paths.edit };
    links.title = { method: 'PUT', href: paths.title };
  }
  if (includeSnapshotRoute) {
    links.snapshot = paths.snapshot;
  }
  if (includeEditV2Route) {
    links.editV2 = { method: 'POST', href: paths.editV2 };
  }
  if (includeBridgeRoutes) {
    links.bridge = {
      state: paths.bridgeState,
      marks: paths.bridgeMarks,
      comment: { method: 'POST', href: paths.bridgeComments },
      suggestion: { method: 'POST', href: paths.bridgeSuggestions },
      rewrite: { method: 'POST', href: paths.bridgeRewrite },
      presence: { method: 'POST', href: paths.bridgePresence },
    };
  }
  return links;
}

export function buildProofSdkAgentDescriptor(
  slug: string,
  {
    origin,
    includeMutationRoutes = true,
    includeSnapshotRoute = false,
    includeEditV2Route = false,
    includeBridgeRoutes = false,
  }: ProofSdkRouteOptions = {},
): Record<string, unknown> {
  const paths = buildProofSdkDocumentPaths(slug, origin);
  const agent: Record<string, unknown> = {
    what: 'Proof is a collaborative document editor. This is a shared doc.',
    docs: paths.docs,
    createApi: paths.create,
    stateApi: paths.state,
    presenceApi: paths.presence,
    eventsApi: paths.events,
  };
  if (includeMutationRoutes) {
    agent.opsApi = paths.ops;
    agent.editApi = paths.edit;
    agent.titleApi = paths.title;
  }
  if (includeSnapshotRoute) {
    agent.snapshotApi = paths.snapshot;
  }
  if (includeEditV2Route) {
    agent.editV2Api = paths.editV2;
  }
  if (includeBridgeRoutes) {
    agent.bridgeApi = {
      state: paths.bridgeState,
      marks: paths.bridgeMarks,
      comments: paths.bridgeComments,
      suggestions: paths.bridgeSuggestions,
      rewrite: paths.bridgeRewrite,
      presence: paths.bridgePresence,
      events: paths.events,
      ack: paths.eventsAck,
    };
  }
  return agent;
}
