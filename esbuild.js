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

const assetOrderCliConfig = {
  entryPoints: ['src/cli/orderAssets.ts'],
  bundle: true,
  outfile: 'out/order-assets.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
};

const definitionMigrationCliConfig = {
  entryPoints: ['src/cli/migrateDefinitions.ts'],
  bundle: true,
  outfile: 'out/migrate-definitions.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
};

const researchInterlinksCliConfig = {
  entryPoints: ['src/cli/linkResearchNodes.ts'],
  bundle: true,
  outfile: 'out/link-research-nodes.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
};

const proofIdeasCliConfig = {
  entryPoints: ['src/cli/syncProofIdeas.ts'],
  bundle: true,
  outfile: 'out/sync-proof-ideas.cjs',
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
};

const ideaPlanMigrationCliConfig = {
  entryPoints: ['src/cli/migrateIdeaPlans.ts'],
  bundle: true,
  outfile: 'out/migrate-idea-plans.cjs',
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
  if (isWatch) {
    const [extCtx, webCtx, cliCtx, migrationCtx, interlinksCtx, proofIdeasCtx, ideaPlanMigrationCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
      esbuild.context(assetOrderCliConfig),
      esbuild.context(definitionMigrationCliConfig),
      esbuild.context(researchInterlinksCliConfig),
      esbuild.context(proofIdeasCliConfig),
      esbuild.context(ideaPlanMigrationCliConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch(), cliCtx.watch(), migrationCtx.watch(), interlinksCtx.watch(), proofIdeasCtx.watch(), ideaPlanMigrationCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(assetOrderCliConfig),
      esbuild.build(definitionMigrationCliConfig),
      esbuild.build(researchInterlinksCliConfig),
      esbuild.build(proofIdeasCliConfig),
      esbuild.build(ideaPlanMigrationCliConfig),
    ]);
    console.log('Build complete.');
  }
}

main().catch(() => process.exit(1));
