import type { Router } from 'express';
import {
  bridgeRoutes,
  type BridgeAuthMode,
  type BridgeExecutorProof,
  type BridgeMethod,
  type BridgeRoute,
} from '../../../src/bridge/bridge-routes.js';

export interface AgentBridgeClientConfig {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  auth?: {
    bearerToken?: string;
    bridgeToken?: string;
    shareToken?: string;
  };
}

export interface AgentBridgeRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface AgentBridgeSuggestionInput {
  by: string;
  kind: 'insert' | 'delete' | 'replace';
  quote: string;
  content?: string;
  range?: { from: number; to: number };
}

export interface AgentBridgeCommentInput {
  by: string;
  text: string;
  quote?: string;
  selector?: Record<string, unknown>;
}

export interface AgentBridgePresenceInput {
  status: string;
  agentId?: string;
  summary?: string;
  details?: string;
  name?: string;
  color?: string;
  avatar?: string;
}

export interface AgentProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface AgentProviderTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface AgentProviderRequest {
  messages: AgentProviderMessage[];
  tools?: AgentProviderTool[];
  metadata?: Record<string, unknown>;
}

export interface AgentProviderResponse {
  message: AgentProviderMessage;
  text?: string;
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
}

export interface AgentProvider {
  complete(request: AgentProviderRequest): Promise<AgentProviderResponse>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildAuthHeaders(config: AgentBridgeClientConfig): Record<string, string> {
  const headers: Record<string, string> = {
    ...(config.headers ?? {}),
  };

  if (config.auth?.bridgeToken) {
    headers['x-bridge-token'] = config.auth.bridgeToken;
  } else if (config.auth?.bearerToken) {
    headers.authorization = `Bearer ${config.auth.bearerToken}`;
  } else if (config.auth?.shareToken) {
    headers['x-share-token'] = config.auth.shareToken;
  }

  return headers;
}

function documentBasePath(slug: string): string {
  return `/documents/${encodeURIComponent(slug)}`;
}

export function buildDocumentPath(slug: string): string {
  return documentBasePath(slug);
}

export function buildBridgePath(slug: string, suffix: string): string {
  return `${documentBasePath(slug)}/bridge${suffix}`;
}

export function buildEventsPath(slug: string, after: number = 0, limit?: number): string {
  const params = new URLSearchParams({ after: String(after) });
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    params.set('limit', String(limit));
  }
  return `${documentBasePath(slug)}/events/pending?${params.toString()}`;
}

async function requestJson<T>(
  config: AgentBridgeClientConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const fetchImpl = config.fetch ?? fetch;
  const response = await fetchImpl(`${trimTrailingSlash(config.baseUrl)}${path}`, {
    ...init,
    headers: {
      ...buildAuthHeaders(config),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body = {} as T;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = { raw: text } as T;
    }
  }
  if (!response.ok) {
    const error = typeof (body as Record<string, unknown>)?.error === 'string'
      ? String((body as Record<string, unknown>).error)
      : `${response.status} ${response.statusText}`.trim();
    throw new Error(error);
  }
  return body;
}

export async function createAgentBridgeRouter(): Promise<Router> {
  const { bridgeRouter } = await import('../../../server/bridge.js');
  return bridgeRouter;
}

export function createAgentBridgeClient(config: AgentBridgeClientConfig) {
  return {
    getState<T = unknown>(slug: string, options: AgentBridgeRequestOptions = {}): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/state'), {
        method: 'GET',
        ...options,
      });
    },
    getMarks<T = unknown>(slug: string, options: AgentBridgeRequestOptions = {}): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/marks'), {
        method: 'GET',
        ...options,
      });
    },
    addComment<T = unknown>(slug: string, input: AgentBridgeCommentInput, options: AgentBridgeRequestOptions = {}): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/comments'), {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    addSuggestion<T = unknown>(slug: string, input: AgentBridgeSuggestionInput, options: AgentBridgeRequestOptions = {}): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/suggestions'), {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    rewrite<T = unknown>(slug: string, input: Record<string, unknown>, options: AgentBridgeRequestOptions = {}): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/rewrite'), {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    setPresence<T = unknown>(slug: string, input: AgentBridgePresenceInput, options: AgentBridgeRequestOptions = {}): Promise<T> {
      return requestJson<T>(config, `${documentBasePath(slug)}/presence`, {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    replyToComment<T = unknown>(
      slug: string,
      input: { markId: string; by: string; text: string },
      options: AgentBridgeRequestOptions = {},
    ): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/comments/reply'), {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    resolveComment<T = unknown>(
      slug: string,
      input: { markId: string },
      options: AgentBridgeRequestOptions = {},
    ): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/comments/resolve'), {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    acceptMark<T = unknown>(
      slug: string,
      input: { markId: string },
      options: AgentBridgeRequestOptions = {},
    ): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/marks/accept'), {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    rejectMark<T = unknown>(
      slug: string,
      input: { markId: string },
      options: AgentBridgeRequestOptions = {},
    ): Promise<T> {
      return requestJson<T>(config, buildBridgePath(slug, '/marks/reject'), {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
    getPendingEvents<T = unknown>(
      slug: string,
      after: number = 0,
      limit?: number,
      options: AgentBridgeRequestOptions = {},
    ): Promise<T> {
      return requestJson<T>(config, buildEventsPath(slug, after, limit), {
        method: 'GET',
        ...options,
      });
    },
    ackEvents<T = unknown>(
      slug: string,
      input: { upToId: number; by?: string },
      options: AgentBridgeRequestOptions = {},
    ): Promise<T> {
      return requestJson<T>(config, `${documentBasePath(slug)}/events/ack`, {
        method: 'POST',
        body: JSON.stringify(input),
        ...options,
      });
    },
  };
}

export {
  bridgeRoutes,
  type BridgeAuthMode,
  type BridgeExecutorProof,
  type BridgeMethod,
  type BridgeRoute,
};
