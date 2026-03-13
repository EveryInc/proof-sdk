async function run(): Promise<void> {
  const core = await import('../../packages/doc-core/src/index.ts');
  const sqlite = await import('../../packages/doc-store-sqlite/src/index.ts');
  const server = await import('../../packages/doc-server/src/index.ts');
  const editorBatch = await import('../../packages/doc-editor/src/batch-executor.ts');
  const editorComments = await import('../../packages/doc-editor/src/plugins/comments.ts');
  const editorSuggestions = await import('../../packages/doc-editor/src/plugins/suggestions.ts');

  if (typeof core.getMarkColor !== 'function') {
    throw new Error('Expected @proof/core surface to expose getMarkColor');
  }

  if (typeof sqlite.createSqliteDocumentStore !== 'function') {
    throw new Error('Expected @proof/sqlite surface to expose createSqliteDocumentStore');
  }

  if (typeof sqlite.createDocument !== 'function') {
    throw new Error('Expected @proof/sqlite surface to expose createDocument');
  }

  if (typeof server.mountProofSdkRoutes !== 'function') {
    throw new Error('Expected @proof/server surface to expose mountProofSdkRoutes');
  }

  if (typeof server.createDocumentRouter !== 'function') {
    throw new Error('Expected @proof/server surface to expose createDocumentRouter');
  }

  if (typeof server.createBridgeRouter !== 'function') {
    throw new Error('Expected @proof/server surface to expose createBridgeRouter');
  }

  if (typeof editorBatch.executeBatch !== 'function') {
    throw new Error('Expected @proof/editor batch surface to expose executeBatch');
  }

  if (typeof editorComments.addComment !== 'function') {
    throw new Error('Expected @proof/editor comments surface to expose addComment');
  }

  if (typeof editorComments.getUnresolvedPluginComments !== 'function') {
    throw new Error('Expected @proof/editor comments surface to expose getUnresolvedPluginComments');
  }

  if (typeof editorSuggestions.wrapTransactionForSuggestions !== 'function') {
    throw new Error('Expected @proof/editor suggestions surface to expose wrapTransactionForSuggestions');
  }

  console.log('proof-sdk-package-surfaces.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
