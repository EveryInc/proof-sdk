export function getAgentMutationRouteLabelFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return `/${parts.slice(1).join('/')}`;
}
