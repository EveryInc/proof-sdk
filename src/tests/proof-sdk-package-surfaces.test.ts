async function run(): Promise<void> {
  const core = await import('../../packages/doc-core/src/index.ts');
  const sqlite = await import('../../packages/doc-store-sqlite/src/index.ts');
  const server = await import('../../packages/doc-server/src/index.ts');
  const editorBatch = await import('../../packages/doc-editor/src/batch-executor.ts');

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

  if (typeof editorBatch.executeBatch !== 'function') {
    throw new Error('Expected @proof/editor batch surface to expose executeBatch');
  }

  console.log('proof-sdk-package-surfaces.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
