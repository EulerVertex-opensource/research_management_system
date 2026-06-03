// @ts-check
const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
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

async function main() {
  if (isWatch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('Build complete.');
  }
}

main().catch(() => process.exit(1));
