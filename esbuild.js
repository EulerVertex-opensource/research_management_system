// @ts-check
const esbuild = require('esbuild');
const fs = require('fs/promises');
const path = require('path');

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  // Prefer ESM package entry points so dependencies such as jsonc-parser are
  // fully bundled instead of retaining unresolved UMD-relative requires.
  mainFields: ['module', 'main'],
  sourcemap: true,
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview-src/index.tsx'],
  bundle: true,
  // outdir instead of outfile so esbuild extracts CSS into main.css alongside main.js
  outdir: 'out/webview',
  entryNames: 'main',
  format: 'iife',
  platform: 'browser',
  sourcemap: true,
  // The dashboard bundle carries React, KaTeX, and pdf.js; minifying keeps the webview quick to load. Sourcemaps keep it debuggable.
  minify: !isWatch,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // Copy font files referenced by KaTeX CSS into the output directory
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.eot': 'file',
  },
};

const researchMaintenanceCliConfig = {
  entryPoints: ['src/cli/researchMaintenance.ts'],
  bundle: true,
  outfile: 'out/research-maintenance.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
};

const researchLoopCliConfig = {
  entryPoints: ['src/cli/researchLoop.ts'],
  bundle: true,
  outfile: 'out/research-loop.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
  // Stamped on approvals and shared research records as extension_version.
  define: { __EXTENSION_VERSION__: JSON.stringify(require('./package.json').version) },
};

const researchLoopMcpConfig = {
  entryPoints: ['src/cli/researchLoopMcp.ts'],
  bundle: true,
  outfile: 'out/research-loop-mcp.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
};

const manuscriptWritingCliConfig = {
  entryPoints: ['src/cli/manuscriptWriting.ts'],
  bundle: true,
  outfile: 'out/manuscript-writing.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
};

async function main() {
  await fs.mkdir(path.join('out', 'webview'), { recursive: true });
  await fs.copyFile(
    require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'),
    path.join('out', 'webview', 'pdf.worker.min.mjs')
  );
  await fs.copyFile(
    path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'LICENSE'),
    path.join('out', 'webview', 'PDFJS-LICENSE')
  );
  const configs = [
    extensionConfig,
    webviewConfig,
    researchMaintenanceCliConfig,
    manuscriptWritingCliConfig,
    researchLoopCliConfig,
    researchLoopMcpConfig,
  ];
  if (isWatch) {
    const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((context) => context.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(configs.map((config) => esbuild.build(config)));
    console.log('Build complete.');
  }
}

main().catch(() => process.exit(1));
