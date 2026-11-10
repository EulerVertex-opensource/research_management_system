// Token usage from the agents' transcripts: parsing (Claude Code, Codex), incremental collection, and the Usage view.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { emptyFileUsage, consumeLine } = load('../src/domain/usageParse.ts');
const { usageSpans, buildUsageView, usageText, stopReason } = load('../src/domain/usageView.ts');
const { collectUsage, knownDrivers, claudeProjectFolder } = load('../src/services/UsageCollector.ts');

const T = (minute, second = 0) => `2026-11-08T22:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const claudeLine = (id, at, usage, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: usage[0], cache_read_input_tokens: usage[1], cache_creation_input_tokens: usage[2], output_tokens: usage[3] } }, ...extra });
const compactLine = (at, pre, post) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at, compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post } });
const codexLine = (at, total, last, limits) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], cache_write_input_tokens: 0, output_tokens: total[2] }, last_token_usage: { input_tokens: last } }, ...(limits ? { rate_limits: limits } : {}) } });
const sum = (usage) => usage.minutes.reduce((a, m) => [a[0] + m[1], a[1] + m[2], a[2] + m[3], a[3] + m[4], a[4] + m[5]], [0, 0, 0, 0, 0]);

test('Claude: a message counts once however many lines repeat it; sidechain and synthetic lines are not the chat\'s', () => {
  const usage = emptyFileUsage('claude');
  for (const line of [
    claudeLine('m1', T(0, 5), [10, 1000, 200, 30]),
    claudeLine('m1', T(0, 6), [10, 1000, 200, 30]),
    claudeLine('m1', T(0, 7), [10, 1000, 200, 45]), // a later block of the same message reports more output
    JSON.stringify({ type: 'user', timestamp: T(0, 8) }),
    claudeLine('m2', T(1, 0), [5, 1200, 0, 20]),
    claudeLine('s1', T(1, 1), [99, 99, 99, 99], { isSidechain: true }),
    JSON.stringify({ type: 'assistant', timestamp: T(1, 2), message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 7 } } }),
    compactLine(T(2), 440000, 12000),
    '{broken',
  ]) consumeLine(usage, line, true);
  assert.deepEqual(sum(usage), [15, 2200, 200, 65, 2]);
  assert.deepEqual(usage.minutes.map((m) => [new Date(m[0]).toISOString(), m[6]]), [[T(0), 1210], [T(1), 1205]]);
  assert.deepEqual(usage.compactions, [{ at: Date.parse(T(2)), trigger: 'auto', before: 440000, after: 12000 }]);
  // A worker's own transcript is all sidechain.
  const worker = emptyFileUsage('claude');
  consumeLine(worker, claudeLine('s1', T(1, 1), [1, 2, 3, 4], { isSidechain: true }), false);
  assert.deepEqual(sum(worker), [1, 2, 3, 4, 1]);
});

test('Codex: a request is the growth of the thread\'s running total, cached tokens taken out of input; limits and compactions are kept', () => {
  const usage = emptyFileUsage('codex');
  const limits = { primary: { used_percent: 12, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 70, window_minutes: 10080, resets_at: 2 } };
  for (const line of [
    codexLine(T(0, 5), [1000, 800, 50], 1000),
    codexLine(T(0, 6), [1000, 800, 50], 1000), // repeated: no growth
    codexLine(T(0, 40), [3000, 2500, 90], 2000, limits),
    `{"timestamp":"${T(3)}","ordinal":665,"type":"compacted","payload":{"message":"","replacement_history":[]}}`,
    JSON.stringify({ timestamp: T(4), type: 'event_msg', payload: { type: 'token_count', info: null } }),
  ]) consumeLine(usage, line);
  assert.deepEqual(sum(usage), [500, 2500, 0, 90, 2]);
  assert.equal(usage.minutes[0][6], 2000);
  assert.deepEqual(usage.quota, { at: Date.parse(T(0, 40)), primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1 }, secondary: { usedPercent: 70, windowMinutes: 10080, resetsAt: 2 } });
  assert.deepEqual(usage.compactions, [{ at: Date.parse(T(3)), before: 2000 }]);
});

test('runs and their autonomous stretches, newest first; a run never stopped ends where the next starts', () => {
  const spans = usageSpans([
    { at: T(0), runId: 'r1', type: 'started', provider: 'claude' },
    { at: T(1), runId: 'r1', type: 'autonomy_started' },
    { at: T(5), runId: 'r1', type: 'autonomy_handover' },
    { at: T(6), runId: 'r1', type: 'autonomy_started' },
    { at: T(10), runId: 'r2', type: 'started', provider: 'codex' },
    { at: T(12), runId: 'r2', type: 'stopped' },
    { at: T(13), type: 'no run' },
  ]);
  assert.deepEqual(spans.map((span) => [span.id, span.from, span.to, span.provider]), [
    ['run:r2', T(10), T(12), 'codex'],
    ['run:r1', T(0), T(10), 'claude'],
    [`auto:r1:${T(6)}`, T(6), T(10), 'claude'],
    [`auto:r1:${T(1)}`, T(1), T(5), 'claude'],
  ]);
});

function minute(at, fresh, cacheRead, output, context = 0) { return [Date.parse(at), fresh, cacheRead, 0, output, 1, context]; }

test('the view counts the stretch\'s driver chats and their workers, by role, stage and result', () => {
  const events = [
    { at: T(0), runId: 'r1', type: 'started', provider: 'claude' },
    { at: T(0, 30), runId: 'r1', type: 'stage', stage: 'plan', assetId: 'main' },
    { at: T(3), runId: 'r1', type: 'autonomy_started' },
    { at: T(5), runId: 'r1', type: 'stage', stage: 'execute', assetId: 'lemma_a' },
    { at: T(9), runId: 'r1', type: 'stopped' },
  ];
  const threads = [
    { id: 'd1', provider: 'claude', role: 'driver', minutes: [minute(T(1), 10, 100, 5, 50000), minute(T(6), 10, 300, 5, 120000), minute(T(20), 999, 999, 999, 999)], compactions: [{ at: Date.parse(T(7)), before: 130000 }] },
    { id: 'w1', provider: 'claude', role: 'deep', parent: 'd1', minutes: [minute(T(6), 50, 500, 50)], compactions: [] },
    { id: 'w2', provider: 'claude', role: 'light', parent: 'd1', minutes: [minute(T(2), 5, 40, 5)], compactions: [] },
    { id: 'x9', provider: 'claude', role: 'deep', parent: 'teaching-chat', minutes: [minute(T(6), 7777, 0, 0)], compactions: [] },
  ];
  const view = buildUsageView({ events, threads, span: 'run:r1', now: Date.parse(T(30)), resetTokens: 200000, title: (id) => id.toUpperCase() });
  assert.equal(view.selected, 'run:r1');
  assert.deepEqual(view.chats, { drivers: 1, workers: 2 }, 'a worker of a chat that is not a driver is left out');
  assert.deepEqual([view.total.fresh, view.total.cacheRead, view.total.output, view.total.requests], [75, 940, 65, 4], 'usage after the run stopped is not counted');
  assert.equal(view.byRole.driver.cacheRead, 400);
  assert.equal(view.byRole.deep.fresh, 50);
  assert.deepEqual(view.stages.map((stage) => [stage.stage, stage.tokens]), [['execute', 915], ['plan', 165]]);
  assert.deepEqual(view.assets.map((asset) => [asset.id, asset.title, asset.tokens]), [['lemma_a', 'LEMMA_A', 915], ['main', 'MAIN', 165]]);
  assert.deepEqual(view.context.map((series) => series.points), [[[Date.parse(T(1)), 50000], [Date.parse(T(6)), 120000]]]);
  assert.equal(view.compactions.length, 1);
  const last = view.cumulative[view.cumulative.length - 1];
  assert.equal(last[1] + last[2] + last[3] + last[4], 1080, 'the cumulative series ends at the total');

  const stretch = buildUsageView({ events, threads, span: `auto:r1:${T(3)}`, now: Date.parse(T(30)), resetTokens: 200000 });
  assert.deepEqual([stretch.total.requests, stretch.chats], [2, { drivers: 1, workers: 1 }], 'an autonomous stretch counts only its own minutes');
  assert.match(usageText(view), /Total 1K tokens in 4 requests/);
  assert.match(usageText(view), /By role: driver 430 \(40%\), light 50 \(5%\), deep 600 \(56%\)/);
});

test('driver chats come from the session registry and from the hooks\' events, which carry the transcript', () => {
  const drivers = knownDrivers([
    { type: 'context_size', sessionId: 'a', transcriptPath: '/t/a.jsonl' },
    { type: 'context_size', sessionId: 'a' },
    { type: 'stage', sessionId: 'not-a-driver-event' },
  ], JSON.stringify({ teach: { t: 'x' }, write: {}, drive: { a: 'x', b: 'y' } }));
  assert.deepEqual([...drivers.entries()].sort(), [['a', '/t/a.jsonl'], ['b', '']]);
});

function tempHomes() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const root = path.join(base, 'my_project');
  fs.mkdirSync(path.join(root, '.research-assistant-loop'), { recursive: true });
  return { base, root, claudeHome: path.join(base, 'claude'), codexHome: path.join(base, 'codex') };
}

test('Claude transcripts are found by session, read incrementally, and their workers come from subagents/', async () => {
  const h = tempHomes();
  try {
    const folder = path.join(h.claudeHome, 'projects', claudeProjectFolder(h.root));
    assert.match(claudeProjectFolder('/Users/me/overleaf_projects/hyper bolic'), /^-Users-me-overleaf-projects-hyper-bolic$/);
    fs.mkdirSync(path.join(folder, 'd1', 'subagents'), { recursive: true });
    const main = path.join(folder, 'd1.jsonl');
    fs.writeFileSync(main, [claudeLine('m1', T(0), [1, 100, 0, 10]), claudeLine('m1', T(0), [1, 100, 0, 10])].join('\n') + '\n' + claudeLine('m2', T(1), [2, 200, 0, 20]).slice(0, 30));
    fs.writeFileSync(path.join(folder, 'd1', 'subagents', 'agent-w1.jsonl'), claudeLine('w', T(1), [5, 50, 5, 5], { isSidechain: true }) + '\n');
    fs.writeFileSync(path.join(folder, 'd1', 'subagents', 'agent-w1.meta.json'), JSON.stringify({ agentType: 'research-worker-deep', description: 'Execute lemma_a' }));
    const options = { root: h.root, drivers: new Map([['d1', '']]), claudeHome: h.claudeHome, codexHome: h.codexHome };
    const first = await collectUsage(options);
    assert.deepEqual(first.problems, []);
    const driver = (result) => result.threads.find((thread) => thread.id === 'd1');
    assert.deepEqual(sum(driver(first)), [1, 100, 0, 10, 1], 'a line still being written waits');
    assert.deepEqual(first.threads.find((thread) => thread.id === 'agent-w1'), { id: 'agent-w1', provider: 'claude', role: 'deep', parent: 'd1', label: 'Execute lemma_a', minutes: [[Date.parse(T(1)), 5, 50, 5, 5, 1, 60]], compactions: [], stops: [] });
    // The line completes and another is appended: only the new part is read, and nothing counts twice.
    fs.writeFileSync(main, fs.readFileSync(main, 'utf8').slice(0, -30) + claudeLine('m2', T(1), [2, 200, 0, 20]) + '\n' + claudeLine('m3', T(2), [3, 300, 0, 30]) + '\n');
    assert.deepEqual(sum(driver(await collectUsage(options))), [6, 600, 0, 60, 3]);
    // A later run knows the driver from the cache even when the registry has forgotten it.
    assert.deepEqual(sum(driver(await collectUsage({ ...options, drivers: new Map() }))), [6, 600, 0, 60, 3]);
    // A transcript replaced by a shorter one is read again from the start.
    fs.writeFileSync(main, claudeLine('n1', T(5), [9, 9, 9, 9]) + '\n');
    assert.deepEqual(sum(driver(await collectUsage(options))), [9, 9, 9, 9, 1]);
  } finally { fs.rmSync(h.base, { recursive: true, force: true }); }
});

test('Codex rollouts are found by thread id, and workers by the parent thread named in their first line', async () => {
  const h = tempHomes();
  try {
    const day = path.join(h.codexHome, 'sessions', '2026', '11', '08');
    const next = path.join(h.codexHome, 'sessions', '2026', '11', '09');
    const earlier = path.join(h.codexHome, 'sessions', '2026', '11', '07');
    for (const folder of [day, next, earlier]) fs.mkdirSync(folder, { recursive: true });
    const driverId = '01a188fb-ba44-7ce2-8d58-dc1cd476d852';
    const meta = (id, source) => JSON.stringify({ timestamp: T(0), type: 'session_meta', payload: { id, source } });
    fs.writeFileSync(path.join(day, `rollout-2026-11-08T22-00-00-${driverId}.jsonl`), [meta(driverId, 'vscode'), codexLine(T(0, 30), [1000, 900, 10], 1000)].join('\n') + '\n');
    const child = (id, role, parent = driverId, folder = next) => fs.writeFileSync(path.join(folder, `rollout-2026-11-09T01-00-00-${id}.jsonl`), [meta(id, { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/lemma_a_execute', agent_nickname: 'Kant', agent_role: role } } }), codexLine(T(1), [500, 400, 5], 500)].join('\n') + '\n');
    child('01a18900-0000-7000-8000-000000000001', 'research-worker-deep');
    child('01a18900-0000-7000-8000-000000000002', 'research-worker-light', 'someone-else');
    child('01a18900-0000-7000-8000-000000000003', 'research-worker-light', driverId, earlier);
    const { threads, problems } = await collectUsage({ root: h.root, drivers: new Map([[driverId, '']]), claudeHome: h.claudeHome, codexHome: h.codexHome });
    assert.deepEqual(problems, []);
    assert.deepEqual(threads.map((thread) => [thread.id, thread.provider, thread.role, thread.parent, thread.label]), [
      [driverId, 'codex', 'driver', undefined, undefined],
      ['01a18900-0000-7000-8000-000000000001', 'codex', 'deep', driverId, 'lemma_a_execute'],
    ], 'another chat\'s worker, and a rollout from before the driver began, are not this driver\'s');
    assert.deepEqual(sum(threads[1]), [100, 400, 0, 5, 1]);
    const missing = await collectUsage({ root: h.root, drivers: new Map([['gone', '']]), claudeHome: h.claudeHome, codexHome: h.codexHome });
    assert.match(missing.problems.join('\n'), /No transcript found for chat gone/);
  } finally { fs.rmSync(h.base, { recursive: true, force: true }); }
});

test('research-loop usage lists the stretches and summarizes one from the transcripts', () => {
  const h = tempHomes();
  const cli = path.resolve(__dirname, '../out/research-loop.cjs');
  try {
    fs.writeFileSync(path.join(h.root, '.research-assistant.json'), JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    fs.mkdirSync(path.join(h.root, 'research'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'research/project.md'), '# Project\n');
    const folder = path.join(h.claudeHome, 'projects', 'anywhere');
    fs.mkdirSync(folder, { recursive: true });
    const transcript = path.join(folder, 'drv.jsonl');
    fs.writeFileSync(transcript, [claudeLine('m1', T(1), [10, 90000, 0, 100]), claudeLine('m2', T(2), [10, 150000, 0, 100])].join('\n') + '\n');
    fs.writeFileSync(path.join(h.root, '.research-assistant-loop/events.jsonl'), [
      { at: T(0), runId: 'r1', type: 'started', provider: 'claude' },
      { at: T(0, 30), runId: 'r1', type: 'stage', stage: 'execute', assetId: 'lemma_a' },
      { at: T(1), runId: 'r1', type: 'context_size', sessionId: 'drv', transcriptPath: transcript, tokens: 90010 },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    const run = (...args) => spawnSync(process.execPath, [cli, 'usage', ...args, '--project', h.root], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: h.claudeHome, CODEX_HOME: h.codexHome } });
    const list = run('--list');
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^1\. run .* → now  \[run:r1\]/);
    const summary = run('--span', '1');
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /Total 240K tokens in 2 requests/);
    assert.match(summary.stdout, /Chats: 1 driver, 0 worker \(Claude Code\)/);
    assert.match(summary.stdout, /By stage: execute 240K \(100%\)/);
    assert.match(summary.stdout, /Driver context: peak 150K; 0 compaction/);
    assert.equal(JSON.parse(run('--json').stdout).chats.drivers, 1);
    assert.match(run('--span', '7').stderr, /No span 7/);
  } finally { fs.rmSync(h.base, { recursive: true, force: true }); }
});

test('a turn that ended on an error is a stop: Claude\'s final API error, Codex\'s task_complete with an error; retries are not', () => {
  const claude = emptyFileUsage('claude');
  consumeLine(claude, JSON.stringify({ type: 'system', subtype: 'api_error', timestamp: T(0), error: { message: 'Connection error.' }, retryAttempt: 1 }));
  consumeLine(claude, JSON.stringify({ type: 'assistant', timestamp: T(1), isApiErrorMessage: true, error: 'rate_limit', message: { id: 'e', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3:50pm" }] } }));
  assert.deepEqual(claude.stops, [{ at: Date.parse(T(1)), message: "You've hit your session limit · resets 3:50pm" }]);
  assert.deepEqual(sum(claude), [0, 0, 0, 0, 0], 'the error message is no request');
  const codex = emptyFileUsage('codex');
  consumeLine(codex, JSON.stringify({ timestamp: T(2), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }));
  consumeLine(codex, JSON.stringify({ timestamp: T(3), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null, error: { message: 'Error running remote compact task: Connection reset' } } }));
  assert.deepEqual(codex.stops, [{ at: Date.parse(T(3)), message: 'Error running remote compact task: Connection reset' }]);
  assert.equal(stopReason("You\u2019ve hit your usage limit. Upgrade to Pro"), 'usage limit');
  assert.equal(stopReason('Error running remote compact task: Co'), 'compaction failed');
  assert.equal(stopReason('Something else'), 'error');
});

test('long gaps without requests are stalls, named by the error that ended a turn just before them', () => {
  const at = (hour, minute = 0) => Date.parse(`2026-11-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
  const m = (time) => [time, 1, 100, 0, 1, 1, 1000];
  const events = [{ at: new Date(at(0)).toISOString(), runId: 'r', type: 'started', provider: 'claude' }, { at: new Date(at(14)).toISOString(), runId: 'r', type: 'stopped' }];
  const threads = [
    { id: 'd', provider: 'codex', role: 'driver', minutes: [m(at(0)), m(at(1)), m(at(5)), m(at(5, 10)), m(at(12))], compactions: [], stops: [{ at: at(1, 0) + 30_000, message: "You've hit your usage limit." }, { at: at(12, 0) + 5_000, message: 'Error running remote compact task' }] },
    { id: 'w', provider: 'codex', role: 'deep', parent: 'd', minutes: [m(at(5, 20))], compactions: [] },
  ];
  const view = buildUsageView({ events, threads, now: at(20), resetTokens: 200000 });
  assert.deepEqual(view.providers, ['codex']);
  assert.deepEqual(view.stalls.map((stall) => [new Date(stall.from).toISOString().slice(11, 16), new Date(stall.to).toISOString().slice(11, 16), stall.reason]), [
    ['00:01', '01:00', undefined],
    ['01:01', '05:00', 'usage limit'],
    ['05:21', '12:00', undefined],
    ['12:01', '14:00', 'compaction failed'],
  ], 'a worker\'s request ends a gap; a stretch that ends stopped on an error stalls to its end');
  assert.match(usageText(view), /Stopped: 59m from .* \(no activity\); 4\.0h from .* after a usage limit; .*; 2\.0h from .* after a failed compaction\./);
});
