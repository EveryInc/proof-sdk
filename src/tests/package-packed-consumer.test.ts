import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type PackedPackage = {
  dirName: string;
  packageDir: string;
};

const PACKED_PACKAGES: PackedPackage[] = [
  { dirName: 'core', packageDir: 'packages/doc-core' },
  { dirName: 'editor', packageDir: 'packages/doc-editor' },
  { dirName: 'server', packageDir: 'packages/doc-server' },
  { dirName: 'sqlite', packageDir: 'packages/doc-store-sqlite' },
];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function readPackageJson(packageDir: string): {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
  };
}

function linkDependency(rootDir: string, fixtureNodeModulesDir: string, packageName: string): void {
  const rootNodeModulesDir = path.join(rootDir, 'node_modules');
  const pathSegments = packageName.split('/');
  const sourcePath = path.join(rootNodeModulesDir, ...pathSegments);
  const targetPath = path.join(fixtureNodeModulesDir, ...pathSegments);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  symlinkSync(sourcePath, targetPath, 'junction');
}

function collectDeclaredExternalDependencies(proofScopeDir: string): string[] {
  const dependencyNames = new Set<string>();
  for (const packedPackage of PACKED_PACKAGES) {
    const packageJson = readPackageJson(path.join(proofScopeDir, packedPackage.dirName));
    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      if (!dependencyName.startsWith('@proof/')) dependencyNames.add(dependencyName);
    }
    for (const dependencyName of Object.keys(packageJson.peerDependencies ?? {})) {
      if (!dependencyName.startsWith('@proof/')) dependencyNames.add(dependencyName);
    }
  }
  return [...dependencyNames].sort();
}

function packWorkspacePackage(rootDir: string, packageDir: string, packDir: string, npmCacheDir: string): string {
  const tarballName = execFileSync(
    'npm',
    ['pack', `./${packageDir}`, '--pack-destination', packDir],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: npmCacheDir,
        npm_config_cache: npmCacheDir,
      },
    },
  ).trim();
  return path.join(packDir, tarballName);
}

function unpackTarball(tarballPath: string, destinationDir: string): void {
  mkdirSync(destinationDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', destinationDir, '--strip-components=1']);
}

function run(): void {
  const rootDir = process.cwd();
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'proof-sdk-packed-consumer-'));
  const packDir = path.join(fixtureDir, 'packs');
  const npmCacheDir = path.join(fixtureDir, 'npm-cache');
  const fixtureNodeModulesDir = path.join(fixtureDir, 'node_modules');
  const proofScopeDir = path.join(fixtureNodeModulesDir, '@proof');

  mkdirSync(packDir, { recursive: true });
  mkdirSync(npmCacheDir, { recursive: true });
  mkdirSync(proofScopeDir, { recursive: true });

  for (const packedPackage of PACKED_PACKAGES) {
    const tarballPath = packWorkspacePackage(rootDir, packedPackage.packageDir, packDir, npmCacheDir);
    unpackTarball(tarballPath, path.join(proofScopeDir, packedPackage.dirName));
  }

  for (const dependencyName of collectDeclaredExternalDependencies(proofScopeDir)) {
    linkDependency(rootDir, fixtureNodeModulesDir, dependencyName);
  }

  writeFileSync(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify({ name: 'proof-sdk-packed-consumer-fixture', private: true, type: 'module' }, null, 2),
  );

  const editorPackageJson = readPackageJson(path.join(proofScopeDir, 'editor'));
  assert(
    editorPackageJson.exports && !Object.prototype.hasOwnProperty.call(editorPackageJson.exports, './editor'),
    'Expected packed @proof/editor artifact to omit the removed ./editor export',
  );

  const smokeScript = `
    const core = await import('@proof/core');
    const coreMarks = await import('@proof/core/marks');
    const editor = await import('@proof/editor');
    const editorComments = await import('@proof/editor/plugins/comments');
    const editorSuggestions = await import('@proof/editor/plugins/suggestions');
    const editorMarks = await import('@proof/editor/plugins/marks');
    const server = await import('@proof/server');
    const serverDb = await import('@proof/server/db');
    const sqlite = await import('@proof/sqlite');

    if (typeof core.getMarkColor !== 'function') throw new Error('Missing @proof/core root export');
    if (typeof coreMarks.getMarkColor !== 'function') throw new Error('Missing @proof/core/marks export');
    if (typeof editor.executeBatch !== 'function') throw new Error('Missing @proof/editor executeBatch export');
    if (typeof editorComments.addComment !== 'function') throw new Error('Missing @proof/editor comments export');
    if (typeof editorSuggestions.wrapTransactionForSuggestions !== 'function') throw new Error('Missing @proof/editor suggestions export');
    if (typeof editorMarks.suggestReplace !== 'function') throw new Error('Missing @proof/editor marks export');
    if (typeof server.mountProofSdkRoutes !== 'function') throw new Error('Missing @proof/server root export');
    if (typeof serverDb.getDocumentBySlug !== 'function') throw new Error('Missing @proof/server/db export');
    if (typeof sqlite.createSqliteDocumentStore !== 'function') throw new Error('Missing @proof/sqlite root export');

    let removedEditorEntrypointResolved = false;
    try {
      await import('@proof/editor/editor');
      removedEditorEntrypointResolved = true;
    } catch {}
    if (removedEditorEntrypointResolved) throw new Error('Unexpected @proof/editor/editor export in packed consumer');
  `;

  execFileSync(process.execPath, ['--input-type=module', '--eval', smokeScript], {
    cwd: fixtureDir,
    stdio: 'pipe',
  });

  console.log('package-packed-consumer.test.ts passed');
}

run();
