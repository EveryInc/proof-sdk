async function run(): Promise<void> {
  const packageMetrics = await import('../../packages/doc-server/src/metrics.ts');
  const shimMetrics = await import('../../server/metrics.ts');
  const packageWs = await import('../../packages/doc-server/src/ws.ts');
  const shimWs = await import('../../server/ws.ts');
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
