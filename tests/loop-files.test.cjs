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

test('writes and deletions do not follow a symbolic link out of the project; reads still do', () => withRoot('loop-symlink-', async (root) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'paper.md'), 'outside');
    fs.mkdirSync(path.join(root, 'research'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'research', 'linked'));
    const files = new NodeLoopFiles(root);
    await assert.rejects(files.writeFile('research/linked/escape.md', 'x'), /symbolic link/);
    await assert.rejects(files.writeFile('research/linked/new/deeper.md', 'x'), /symbolic link/);
    await assert.rejects(files.appendFile('research/linked/log.jsonl', 'x\n'), /symbolic link/);
    await assert.rejects(files.deleteFile('research/linked/paper.md'), /symbolic link/);
    await assert.rejects(files.writeFile('../escape.md', 'x'), /leaves the project/);
    assert.deepEqual(fs.readdirSync(outside), ['paper.md']);
    assert.equal(await files.readFile('research/linked/paper.md'), 'outside');
    // Ordinary writes, into folders that do not exist yet, are unaffected.
    await files.writeFile('research/assets/a/b.md', 'inside');
    assert.equal(fs.readFileSync(path.join(root, 'research/assets/a/b.md'), 'utf8'), 'inside');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

// The cross-process state lock (F05/F06): one writer of state.json at a time, whatever process it is.
const { STATE_LOCK_PATH } = load('../src/services/StateLock.ts');
const stateFile = '.research-assistant-loop/state.json';
const lockFile = (root) => path.join(root, STATE_LOCK_PATH);
const gate = () => { let open; const opened = new Promise((resolve) => { open = resolve; }); return { opened, open }; };

async function startedRoot(root) {
  fs.mkdirSync(path.join(root, 'research'), { recursive: true });
  fs.writeFileSync(path.join(root, paths.projectMd), '# Project\n\n## Required Results\n');
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths, { iterationCap: 5 });
  await core.transaction('test start', () => core.start('claude', { goal: 'Prove it.' }));
}

test('two writers in different cores never overwrite each other: the second waits and builds on the first', () => withRoot('loop-lock-', async (root) => {
  await startedRoot(root);
  const a = new ResearchLoopCore(new NodeLoopFiles(root), paths);
  const b = new ResearchLoopCore(new NodeLoopFiles(root), paths);
  const held = gate();
  const inside = gate();
  // A takes the lock and works slowly; B (the dashboard pausing, say) arrives meanwhile.
  const first = a.transaction('slow report', async () => { inside.open(); await held.opened; await a.setIterationCap(9); });
  await inside.opened;
  assert.ok(fs.existsSync(lockFile(root)));
  let bDone = false;
  const second = b.transaction('pause', async () => { await b.pause('Paused by the researcher.'); bDone = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bDone, false, 'B waits while A holds the lock');
  held.open();
  await Promise.all([first, second]);
  const state = JSON.parse(fs.readFileSync(path.join(root, stateFile), 'utf8'));
  assert.equal(state.autopilot.iterationCap, 9, "A's change survives");
  assert.equal(state.status, 'paused', "B's change is there too");
  assert.equal(fs.existsSync(lockFile(root)), false, 'the lock is released');
}));

test('two chats claiming the driver lock at once: exactly one wins', () => withRoot('loop-lock-claim-', async (root) => {
  await startedRoot(root);
  const cores = ['chat-a', 'chat-b'].map(() => new ResearchLoopCore(new NodeLoopFiles(root), paths));
  const results = await Promise.all(cores.map((core, i) => core.transaction('hook', () => core.touch(['chat-a', 'chat-b'][i], false, false))));
  const winner = JSON.parse(fs.readFileSync(path.join(root, stateFile), 'utf8')).lock.sessionId;
  // The state starts without a lock, so the first claim succeeds; the second sees it fresh and is refused.
  assert.deepEqual(results.filter(Boolean).length, 1, JSON.stringify(results));
  assert.equal(winner, results[0] ? 'chat-a' : 'chat-b');
}));

test('a lock left by a dead process is broken; a live holder makes the waiter give up with its name', () => withRoot('loop-lock-stale-', async (root) => {
  await startedRoot(root);
  const holder = (pid, op) => JSON.stringify({ token: `t-${pid}`, pid, host: os.hostname(), op, at: new Date().toISOString(), refreshedAt: new Date().toISOString() });
  fs.writeFileSync(lockFile(root), holder(2 ** 22 + 12345, 'crashed command'));
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths, { stateLock: { waitMs: 300 } });
  await core.transaction('after a crash', () => core.setIterationCap(4));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, stateFile), 'utf8')).autopilot.iterationCap, 4);
  fs.writeFileSync(lockFile(root), holder(process.pid, 'research-loop report'));
  await assert.rejects(core.transaction('blocked', () => core.setIterationCap(5)), (error) => error.name === 'StateLockBusy' && /research-loop report \(process \d+/.test(error.message));
  assert.match(fs.readFileSync(lockFile(root), 'utf8'), /research-loop report/, "the live holder's lock is left alone");
}));

test('under the lock, a save over a revision someone else wrote without the lock is refused', () => withRoot('loop-lock-revision-', async (root) => {
  await startedRoot(root);
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths);
  await assert.rejects(core.transaction('report', async () => {
    // An older writer that skips the lock saves meanwhile.
    const raw = JSON.parse(fs.readFileSync(path.join(root, stateFile), 'utf8'));
    fs.writeFileSync(path.join(root, stateFile), JSON.stringify({ ...raw, revision: raw.revision + 1, status: 'paused' }));
    await core.setIterationCap(8);
  }), /changed by another writer.*Nothing was saved/);
  const state = JSON.parse(fs.readFileSync(path.join(root, stateFile), 'utf8'));
  assert.equal(state.status, 'paused', "the other writer's change is not overwritten");
  assert.notEqual(state.autopilot.iterationCap, 8);
}));
