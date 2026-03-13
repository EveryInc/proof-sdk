export type BridgeAuthMode = 'none' | 'bridge-token';
export type BridgeMethod = 'GET' | 'POST';

export interface BridgeRoutePolicy {
  method: BridgeMethod;
  path: string;
  auth: BridgeAuthMode;
  required?: string[];
}

const BRIDGE_ROUTE_POLICIES: BridgeRoutePolicy[] = [
  { method: 'GET', path: '/state', auth: 'none' },
  { method: 'GET', path: '/marks', auth: 'none' },
  { method: 'POST', path: '/marks/comment', auth: 'none', required: ['by', 'text'] },
  { method: 'POST', path: '/comments', auth: 'none', required: ['by', 'text'] },
  { method: 'POST', path: '/marks/suggest-replace', auth: 'none', required: ['quote', 'by', 'content'] },
  { method: 'POST', path: '/marks/suggest-insert', auth: 'none', required: ['quote', 'by', 'content'] },
  { method: 'POST', path: '/marks/suggest-delete', auth: 'none', required: ['quote', 'by'] },
  { method: 'POST', path: '/suggestions', auth: 'none', required: ['kind', 'quote', 'by'] },
  { method: 'POST', path: '/marks/accept', auth: 'bridge-token', required: ['markId'] },
  { method: 'POST', path: '/marks/reject', auth: 'bridge-token', required: ['markId'] },
  { method: 'POST', path: '/marks/reply', auth: 'bridge-token', required: ['markId', 'by', 'text'] },
  { method: 'POST', path: '/marks/resolve', auth: 'bridge-token', required: ['markId'] },
  { method: 'POST', path: '/comments/reply', auth: 'bridge-token', required: ['markId', 'by', 'text'] },
  { method: 'POST', path: '/comments/resolve', auth: 'bridge-token', required: ['markId'] },
  { method: 'POST', path: '/rewrite', auth: 'none' },
  { method: 'POST', path: '/presence', auth: 'bridge-token', required: ['status'] },
];

export function findBridgeRoutePolicy(method: string, path: string): BridgeRoutePolicy | undefined {
  const normalizedMethod = method.toUpperCase() as BridgeMethod;
  return BRIDGE_ROUTE_POLICIES.find((policy) => policy.method === normalizedMethod && policy.path === path);
}

export function getBridgeRoutePolicies(): BridgeRoutePolicy[] {
  return BRIDGE_ROUTE_POLICIES;
}
