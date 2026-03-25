import {
  createAgentBridgeClient,
  type AgentProvider,
  type AgentProviderRequest,
  type AgentProviderResponse,
} from '@proof/agent-bridge';

interface CreateDocumentResponse {
  slug: string;
  ownerSecret: string;
  accessToken: string;
  shareUrl?: string;
  tokenUrl?: string;
  agent?: {
    stateApi?: string;
  };
}

class DemoAgentProvider implements AgentProvider {
  async complete(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === 'user');
    const text = latestUserMessage?.content?.trim() || 'Review the introduction and tighten the opening claim.';
    return {
      message: {
        role: 'assistant',
        content: `Suggested focus: ${text}`,
        name: 'proof-example-agent',
      },
      text: `Suggested focus: ${text}`,
      metadata: {
        provider: 'demo',
      },
    };
  }
}

async function createDocument(baseUrl: string, title: string, markdown: string): Promise<CreateDocumentResponse> {
  const response = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      markdown,
    }),
  });
  if (!response.ok) {
    throw new Error(`Document creation failed with ${response.status}`);
  }
  return response.json() as Promise<CreateDocumentResponse>;
}

async function run(): Promise<void> {
  const baseUrl = (process.env.PROOF_BASE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  const title = process.env.PROOF_DEMO_TITLE || 'Proof SDK Example';
  const markdown = process.env.PROOF_DEMO_MARKDOWN || '# Hello\n\nThis draft needs a stronger opening.';
  const provider = new DemoAgentProvider();

  const created = await createDocument(baseUrl, title, markdown);
  if (!created.slug || !created.ownerSecret) {
    throw new Error('Create response did not include slug/ownerSecret');
  }

  const bridge = createAgentBridgeClient({
    baseUrl,
    auth: {
      bridgeToken: created.ownerSecret,
    },
  });

  await bridge.setPresence(created.slug, {
    agentId: 'agent:proof-example',
    status: 'reviewing',
    summary: 'Reading the current draft',
    name: 'Proof Example Agent',
    color: '#266854',
  });

  const state = await bridge.getState<{ markdown?: string }>(created.slug);
  const review = await provider.complete({
    messages: [
      {
        role: 'system',
        content: 'You are a lightweight review agent operating through the Proof SDK bridge.',
      },
      {
        role: 'user',
        content: state.markdown || markdown,
      },
    ],
    metadata: {
      slug: created.slug,
    },
  });

  await bridge.addComment(created.slug, {
    by: 'ai:proof-example',
    quote: 'stronger opening',
    text: review.text || review.message.content,
  });

  const viewUrl = created.tokenUrl
    ?? (created.shareUrl && created.accessToken
      ? `${created.shareUrl}?token=${encodeURIComponent(created.accessToken)}`
      : `${baseUrl}/d/${created.slug}`);

  console.log(JSON.stringify({
    success: true,
    slug: created.slug,
    viewUrl,
    stateApi: created.agent?.stateApi ?? `${baseUrl}/documents/${created.slug}/state`,
    commentPosted: true,
  }, null, 2));
}

run().catch((error) => {
  console.error('[proof-example] agent bridge demo failed');
  console.error(error);
  process.exit(1);
});
