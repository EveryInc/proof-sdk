async function run(): Promise<void> {
  const core = await import('@proof/core');
  const sqlite = await import('@proof/sqlite');
  const server = await import('@proof/server');
  const editor = await import('@proof/editor');
  const editorBatch = await import('@proof/editor/batch-executor');
  const editorComments = await import('@proof/editor/plugins/comments');
  const editorSuggestions = await import('@proof/editor/plugins/suggestions');
  const editorCodeBlockExt = await import('@proof/editor/schema/code-block-ext');
  const editorFrontmatter = await import('@proof/editor/schema/frontmatter');
  const editorProofMarks = await import('@proof/editor/schema/proof-marks');
  const coreMarks = await import('@proof/core/marks');
  const sqliteTypes = await import('@proof/sqlite/types');
  const serverDocuments = await import('@proof/server/documents');
  const serverDb = await import('@proof/server/db');
  const serverShareTypes = await import('@proof/server/share-types');

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

  if (!['function', 'object'].includes(typeof editor.commentsCtx)) {
    throw new Error('Expected @proof/editor root surface to expose commentsCtx');
  }

  if (typeof editor.getUnresolvedComments !== 'function') {
    throw new Error('Expected @proof/editor root surface to expose getUnresolvedComments');
  }

  if (typeof editor.executeBatch !== 'function') {
    throw new Error('Expected @proof/editor root surface to expose executeBatch');
  }

  if (typeof editor.suggestReplace !== 'function') {
    throw new Error('Expected @proof/editor root surface to expose suggestReplace');
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

  if (!Array.isArray(editorCodeBlockExt.codeBlockExtPlugins)) {
    throw new Error('Expected @proof/editor/schema/code-block-ext to expose codeBlockExtPlugins');
  }

  if (!editorFrontmatter.frontmatterSchema) {
    throw new Error('Expected @proof/editor/schema/frontmatter to expose frontmatterSchema');
  }

  if (!Array.isArray(editorProofMarks.proofMarkPlugins)) {
    throw new Error('Expected @proof/editor/schema/proof-marks to expose proofMarkPlugins');
  }

  if (typeof sqliteTypes !== 'object') {
    throw new Error('Expected @proof/sqlite/types subpath export to resolve');
  }

  if (typeof serverDocuments.createDocumentRouter !== 'function') {
    throw new Error('Expected @proof/server/documents subpath export to expose createDocumentRouter');
  }

  if (typeof serverDb.getDocumentBySlug !== 'function') {
    throw new Error('Expected @proof/server/db subpath export to expose getDocumentBySlug');
  }

  if (typeof serverShareTypes.isShareRole !== 'function') {
    throw new Error('Expected @proof/server/share-types subpath export to expose isShareRole');
  }

  if (typeof editorComments.getUnresolvedPluginComments !== 'function') {
    throw new Error('Expected @proof/editor/plugins/comments subpath export to expose getUnresolvedPluginComments');
  }

  if (typeof coreMarks.getMarkColor !== 'function') {
    throw new Error('Expected @proof/core/marks subpath export to expose getMarkColor');
  }

  console.log('proof-sdk-package-surfaces.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
