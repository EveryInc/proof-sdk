import { build } from 'esbuild';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const packageDir = process.cwd();
const srcDir = path.join(packageDir, 'src');
const distDir = path.join(packageDir, 'dist');

const excludes = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== '--exclude') continue;
  const nextValue = process.argv[index + 1];
  if (!nextValue) continue;
  excludes.add(path.normalize(nextValue));
  index += 1;
}

function collectTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    const relativePath = path.normalize(path.relative(packageDir, fullPath));
    if (excludes.has(relativePath)) continue;
    files.push(relativePath);
  }
  return files;
}

const entryPoints = collectTsFiles(srcDir);
if (entryPoints.length === 0) {
  throw new Error(`No package source files found in ${srcDir}`);
}

rmSync(distDir, { recursive: true, force: true });

await build({
  entryPoints,
  outdir: distDir,
  outbase: 'src',
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  sourcemap: true,
  packages: 'external',
  logLevel: 'info',
});
