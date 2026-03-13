async function run(): Promise<void> {
  const packageMetrics = await import('../../packages/doc-server/src/metrics.ts');
  const shimMetrics = await import('../../server/metrics.ts');
  const packageWs = await import('../../packages/doc-server/src/ws.ts');
  const shimWs = await import('../../server/ws.ts');
  const packageCollabShared = await import('../../packages/doc-server/src/collab-shared.ts');
  const shimCollab = await import('../../server/collab.ts');
  const packageDb = await import('../../packages/doc-server/src/db.ts');
  const shimDb = await import('../../server/db.ts');
  const packageCanonical = await import('../../packages/doc-server/src/canonical-document-shared.ts');
  const shimCanonical = await import('../../server/canonical-document.ts');
  const packageEngine = await import('../../packages/doc-server/src/document-engine-shared.ts');
  const shimEngine = await import('../../server/document-engine.ts');
  const packageAgentEditOps = await import('../../packages/doc-server/src/agent-edit-ops.ts');
  const shimAgentEditOps = await import('../../server/agent-edit-ops.ts');
  const packageAgentEditV2 = await import('../../packages/doc-server/src/agent-edit-v2.ts');
  const shimAgentEditV2 = await import('../../server/agent-edit-v2.ts');
  const packageHeadless = await import('../../packages/doc-server/src/milkdown-headless.ts');
  const shimHeadless = await import('../../server/milkdown-headless.ts');

  if (packageMetrics.recordShareLinkOpen !== shimMetrics.recordShareLinkOpen) {
    throw new Error('Expected server metrics shim to re-export package metrics implementation');
  }

  if (packageMetrics.renderMetricsText !== shimMetrics.renderMetricsText) {
    throw new Error('Expected server metrics shim to preserve metrics registry exports');
  }

  if (packageWs.setupWebSocket !== shimWs.setupWebSocket) {
    throw new Error('Expected server ws shim to re-export package websocket implementation');
  }

  if (packageWs.getActiveCollabClientCount !== shimWs.getActiveCollabClientCount) {
    throw new Error('Expected server ws shim to preserve collab client counters');
  }

  if (packageCollabShared.getCollabRuntime !== shimCollab.getCollabRuntime) {
    throw new Error('Expected collab shared facade to re-export collab runtime helpers');
  }

  if (packageCollabShared.getCanonicalReadableDocumentSync !== shimCollab.getCanonicalReadableDocumentSync) {
    throw new Error('Expected collab shared facade to preserve canonical read helpers');
  }

  if (packageDb.getDocumentBySlug !== shimDb.getDocumentBySlug) {
    throw new Error('Expected db shim to preserve getDocumentBySlug');
  }

  if (packageDb.updateDocument !== shimDb.updateDocument) {
    throw new Error('Expected db shim to preserve updateDocument');
  }

  if (packageCanonical.executeCanonicalRewrite !== shimCanonical.executeCanonicalRewrite) {
    throw new Error('Expected canonical shared facade to re-export canonical rewrite helpers');
  }

  if (packageEngine.executeDocumentOperationAsync !== shimEngine.executeDocumentOperationAsync) {
    throw new Error('Expected document engine facade to preserve async execution helpers');
  }

  if (packageAgentEditOps.applyAgentEditOperations !== shimAgentEditOps.applyAgentEditOperations) {
    throw new Error('Expected agent edit ops shim to preserve applyAgentEditOperations');
  }

  if (packageAgentEditV2.applyAgentEditV2 !== shimAgentEditV2.applyAgentEditV2) {
    throw new Error('Expected agent edit v2 shim to preserve applyAgentEditV2');
  }

  if (packageHeadless.getHeadlessMilkdownParser !== shimHeadless.getHeadlessMilkdownParser) {
    throw new Error('Expected server milkdown shim to re-export package parser implementation');
  }

  if (packageHeadless.serializeMarkdown !== shimHeadless.serializeMarkdown) {
    throw new Error('Expected server milkdown shim to preserve serializer exports');
  }

  console.log('server-package-internals.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
