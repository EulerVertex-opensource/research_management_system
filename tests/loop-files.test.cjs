const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'], external: ['vscode'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { NodeLoopFiles } = load('../src/cli/nodeFiles.ts');
const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { pathsFromConfigText } = load('../src/services/ProjectPathsCore.ts');
const { isTimelineEvent, buildHistory } = load('../src/domain/history.ts');
const paths = pathsFromConfigText('{}');
const events = '.research-assistant-loop/events.jsonl';

function withRoot(prefix, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return Promise.resolve(run(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test('concurrent loggers in one process and across processes never lose an event line', () => withRoot('loop-events-', async (root) => {
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths);
  await Promise.all(Array.from({ length: 200 }, (_, i) => core.event('context_request', { id: `n${i}` })));
  // Other processes (MCP bridges, the CLI) log through the same file layer at the same time.
  const script = `const { NodeLoopFiles } = require(${JSON.stringify(path.join(root, 'files.cjs'))}); const files = new NodeLoopFiles(${JSON.stringify(root)}); Promise.all(Array.from({ length: 100 }, (_, i) => files.appendFile(${JSON.stringify(events)}, JSON.stringify({ type: 'stage', p: process.pid, i }) + '\\n')));`;
  fs.writeFileSync(path.join(root, 'files.cjs'), esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/cli/nodeFiles.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text);
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => spawn(process.execPath, ['-e', script], { stdio: 'inherit' }).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))))));
  const lines = fs.readFileSync(path.join(root, events), 'utf8').trim().split('\n');
  assert.equal(lines.length, 600);
  for (const line of lines) JSON.parse(line);
}));

test('loop state is replaced whole: a concurrent reader never sees an empty or half-written file', () => withRoot('loop-atomic-', async (root) => {
  const files = new NodeLoopFiles(root);
  const big = (n) => JSON.stringify({ n, filler: 'x'.repeat(256 * 1024) });
  await files.writeFile('.research-assistant-loop/state.json', big(0));
  let writing = true;
  let reads = 0;
  const reader = (async () => {
    while (writing) { JSON.parse(await files.readFile('.research-assistant-loop/state.json')); reads += 1; }
  })();
  for (let n = 1; n <= 60; n += 1) await files.writeFile('.research-assistant-loop/state.json', big(n));
  writing = false;
  await reader;
  assert.ok(reads > 0);
  assert.equal(JSON.parse(await files.readFile('.research-assistant-loop/state.json')).n, 60);
  assert.deepEqual(fs.readdirSync(path.join(root, '.research-assistant-loop')), ['state.json'], 'no temporary files are left');
  // Research files are still written in place.
  await files.writeFile('research/ideas/a.md', 'x');
  assert.equal(fs.readFileSync(path.join(root, 'research/ideas/a.md'), 'utf8'), 'x');
}));

test('a burst of context bookkeeping does not crowd real events out of the Activity window', () => withRoot('loop-timeline-', async (root) => {
  const files = new NodeLoopFiles(root);
  const core = new ResearchLoopCore(files, paths);
  await core.event('stage', { stage: 'scaffold' });
  for (let i = 0; i < 300; i += 1) await core.event('context_request', { id: `n${i}`, stage: 'scaffold' });
  assert.equal((await core.recentEvents(80)).filter(isTimelineEvent).length, 0, 'the unfiltered window holds only bookkeeping');
  const shown = await core.recentEvents(80, isTimelineEvent);
  assert.deepEqual(shown.map((event) => event.type), ['stage']);
  assert.equal(buildHistory(shown, (id) => id)[0].text, 'Started setting up the results to prove.');
  assert.equal(isTimelineEvent({ type: 'context_request' }), false);
}));
