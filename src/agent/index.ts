import { getSessionManager } from './session-manager';
import type { AgentSessionStatus } from './session-manager';
import type { AgentStatus, AgentStatusInfo } from './types';

function mapSessionStatusToAgentStatus(status: AgentSessionStatus): AgentStatus {
  switch (status) {
    case 'reading':
    case 'thinking':
    case 'acting':
    case 'waiting':
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'error':
    case 'interrupted':
      return 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

export type AgentSessionSummary = {
  id: string;
  status: string;
  currentThinking: string;
  tokensUsed: number;
  estimatedCost: number;
};

export function getAgentStatus(): AgentStatusInfo {
  const sessions = getSessionManager().getAllSessions();
  if (sessions.length === 0) {
    return { status: 'offline' };
  }
  // Report the most recently active session so callers can identify which
  // session the status refers to (the AgentStatusInfo.sessionId contract),
  // rather than collapsing every session into a single running/offline flag.
  const mostRecent = sessions.reduce((latest, session) => (
    session.lastActivity.getTime() > latest.lastActivity.getTime() ? session : latest
  ));
  return {
    status: mapSessionStatusToAgentStatus(mostRecent.status),
    sessionId: mostRecent.id,
    startedAt: mostRecent.startTime.getTime(),
  };
}

export function getAgentSessionsSummary(): AgentSessionSummary[] {
  return getSessionManager().getAllSessions().map((session) => ({
    id: session.id,
    status: session.status,
    currentThinking: session.currentThinking,
    tokensUsed: session.tokensUsed,
    estimatedCost: session.estimatedCost,
  }));
}

export async function cancelAllAgentSessions(): Promise<{ count: number }> {
  const manager = getSessionManager();
  const sessions = manager.getAllSessions();
  for (const session of sessions) {
    await manager.cancelSession(session.id);
    await manager.discardSession(session.id);
  }
  return { count: sessions.length };
}
