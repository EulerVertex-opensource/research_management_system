const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const { searchNothing, writeRound } = require('./search-fixtures.cjs');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { normalizeLoopSettings, parseLoopSettings, validateSettingsPatch, applyLoopPatch, DEFAULT_LOOP_SETTINGS } = load('../src/domain/loopSettings.ts');
const { normalizeConfig } = load('../src/services/ProjectPathsCore.ts');
const { preToolUseDecision } = load('../src/services/ResearchLoopHooks.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const asset = (proof = '', extra = {}) => matter.stringify(`\n## Statement\n\nFor every natural number n, n = n.\n${proof}`, { type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const node = (type, title, statement, extra = {}) => matter.stringify(`\n## Statement\n\n${statement}\n`, { type, title, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const definition = (text) => matter.stringify(`\n${text}\n`, { type: 'definition', title: 'Definition (natural)', status: 'draft', depends_on: [] });
const plan = (id, status = 'pending', difference = '') => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\nProve reflexivity.\n\n## Plan\n\n1. [ ] Apply equality reflexivity.\n\n## Verification\n\nCheck the equality.\n${difference}${status === 'failed' ? '\n## Failure\n\nThis approach cannot establish the needed equality.\n' : ''}`, { type: 'plan', title: id, status, target_asset: 'main_theorem', inspired_by: [], tags: [] });
const succeeded = (id) => matter.stringify('\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\n## Plan\n\n1. [x] Apply reflexivity.\n\n## Verification\n\nCheck the equality.\n\n## Outcome\n\nProof incorporated into main_theorem.\n', { type: 'plan', title: id, status: 'succeeded', target_asset: 'main_theorem', inspired_by: [], tags: [] });
const check = (target = 'main_theorem') => matter.stringify('\n## Cases checked\n\n- n = 0 and n = 1\n\n## Limitations\n\nOnly small cases.\n', { type: 'falsification_check', title: `Check ${target}`, target_asset: target, outcome: 'no_counterexample_found' });
const SETTINGS = '.research-assistant-loop/settings.json';
const auto = (rules = {}, extra = {}) => JSON.stringify({ version: 1, autoApprove: { enabled: true, ...rules }, ...extra });

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
    deleteFile: async (file) => { map.delete(file); },
  };
}

let counter = 0;
function fixture(initial = {}, options = { iterationCap: 5 }) {
  const files = memoryFiles({ 'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n', ...initial });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, ...options });
  return { files, core, map: files.map };
}

const record = (f, target) => [...f.map.entries()].filter(([file]) => file.startsWith('research/approvals/')).map(([, raw]) => JSON.parse(raw)).find((entry) => entry.target === target);
const status = (f, file) => matter(f.map.get(file)).data.status;

/** Goals approved by hand, then scaffold and sources up to falsification of main_theorem. */
async function driveToFalsify(f, scaffold = { 'research/assets/main_theorem.md': asset() }) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  if (request) await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  for (const [file, content] of Object.entries(scaffold)) f.map.set(file, content);
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'search');
  await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');
}

async function prove(f, planId = 'attempt_1') {
  f.map.set(`research/plans/${planId}.md`, plan(planId));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId });
  const current = f.map.get('research/assets/main_theorem.md');
  f.map.set('research/assets/main_theorem.md', current.replace(/\n## Proof[\s\S]*$/, '') + `\n## Proof\n\nEquality is reflexive (run ${++counter}).\n`);
  f.map.set(`research/plans/${planId}.md`, succeeded(planId));
  return f.core.report({ outcome: 'proved', summary: 'Proved' });
}

test('loop settings: defaults, clamping, and auto mode failing closed', () => {
  assert.deepEqual(normalizeLoopSettings(undefined).settings, DEFAULT_LOOP_SETTINGS);
  const clamped = normalizeLoopSettings({ maxFailedPlans: 99, iterationCap: 0, questionTimeoutSeconds: 12.6, extra: true }).settings;
  assert.equal(clamped.maxFailedPlans, 10);
  assert.equal(clamped.iterationCap, 1);
  assert.equal(clamped.questionTimeoutSeconds, 13);
  assert.equal('extra' in clamped, false);
  assert.equal(parseLoopSettings('{ not json').settings.autoApprove.enabled, false);
  assert.equal(normalizeLoopSettings({ autoApprove: { enabled: 'yes' } }).settings.autoApprove.enabled, false);
  assert.equal(normalizeLoopSettings({ autoApprove: [] }).problems.length, 1);
  const on = normalizeLoopSettings({ autoApprove: { enabled: true } }).settings.autoApprove;
  assert.deepEqual([on.enabled, on.proofs, on.counterexamples, on.project], [true, true, false, false]);
  assert.equal(applyLoopPatch(DEFAULT_LOOP_SETTINGS, { autoApprove: { enabled: true, definitions: false } }).autoApprove.definitions, false);
});

test('settings patches are validated before anything is written', () => {
  const stages = ['plan', 'execute'];
  assert.deepEqual(validateSettingsPatch({ loop: { maxFailedPlans: 3 }, sync: { remote: 'origin', branch: 'feature/x' }, contextBudgets: { plan: 9000, execute: null } }, stages), {});
  const errors = validateSettingsPatch({ loop: { maxFailedPlans: 0, iterationCap: 2.5 }, agent: { provider: 'gpt' }, sync: { branch: '--upload-pack=x', remote: 'a b', overleafBranch: 'main..x', latexCommand: 'a\nb' }, contextBudgets: { unknown: 1000, plan: 10 } }, stages);
  assert.deepEqual(Object.keys(errors).sort(), ['agent.provider', 'contextBudgets.plan', 'contextBudgets.unknown', 'loop.iterationCap', 'loop.maxFailedPlans', 'sync.branch', 'sync.latexCommand', 'sync.overleafBranch', 'sync.remote']);
});

test('project config keeps contextBudgets and drops invalid entries', () => {
  const config = normalizeConfig({ contextBudgets: { plan: 9000.4, execute: -1, 'Bad-Key': 100, review: 'x' } });
  assert.deepEqual(config.contextBudgets, { plan: 9000 });
  assert.equal('contextBudgets' in normalizeConfig({}), false);
});

test('the agent may not write the loop settings', () => {
  for (const input of [
    { tool_name: 'Write', tool_input: { file_path: '/proj/.research-assistant-loop/settings.json', content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: '.research-assistant-loop/settings.json', new_string: 'true' } },
    { tool_name: 'Bash', tool_input: { command: 'echo \'{"autoApprove":{"enabled":true}}\' > .research-assistant-loop/settings.json' } },
  ]) assert.equal(preToolUseDecision(paths, input, '/proj').deny, true, JSON.stringify(input));
});

test('auto mode approves a proof vouched for by its plan, and the loop reaches ready', async () => {
  const f = fixture();
  await driveToFalsify(f);
  f.map.set(SETTINGS, auto());
  const result = await prove(f);
  assert.match(result.message, /approved automatically/);
  assert.doesNotMatch(result.message, /request_approval/);
  assert.equal(status(f, 'research/assets/main_theorem.md'), 'approved');
  assert.equal(record(f, 'main_theorem').source, 'auto');
  const stamped = matter(f.map.get('research/plans/attempt_1.md')).data;
  assert.equal(typeof stamped.statement_digest, 'string');
  assert.deepEqual(stamped.dependency_digests, {});
  assert.equal((await f.core.next()).stage, 'ready');
  assert.match(f.core.briefStatus(), /Auto mode \(set by the researcher\)/);
  assert.deepEqual((await f.core.validateAll()).filter((problem) => problem.includes('plans/')), []);
});

test('auto approvals in one selection are followed by a fresh one: supporting result and definition, then ready', async () => {
  const f = fixture();
  f.map.set(SETTINGS, auto());
  await driveToFalsify(f, {
    'research/assets/main_theorem.md': asset('', { depends_on: ['note_a'], uses_definitions: ['natural'] }),
    'research/assets/note_a.md': node('remark', 'A remark', 'Equality is reflexive.'),
    'research/definitions/natural.md': definition('A natural number is a member of N.'),
  });
  assert.equal(record(f, 'note_a').source, 'auto');
  await prove(f);
  assert.equal(status(f, 'research/assets/main_theorem.md'), 'approved');
  assert.equal((await f.core.next()).stage, 'ready');
  assert.equal(status(f, 'research/definitions/natural.md'), 'approved');
});

test('a kind switched off stays with the researcher', async () => {
  // Checked at the end (Fast): the definition comes to the researcher once the proof is in.
  const f = fixture();
  f.map.set(SETTINGS, auto({ definitions: false }, { rigor: { agreeDefinitions: 'off' } }));
  await driveToFalsify(f, { 'research/assets/main_theorem.md': asset('', { uses_definitions: ['natural'] }), 'research/definitions/natural.md': definition('A natural number is a member of N.') });
  await prove(f);
  assert.equal((await f.core.next()).stage, 'waiting');
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'definition' && item.target === 'natural'));
  // Agreed before proving (Careful, the default): the same definition comes to the researcher before any search.
  const careful = fixture();
  careful.map.set(SETTINGS, auto({ definitions: false }));
  await careful.core.start('claude', { goal: 'Prove the main theorem.' });
  careful.map.set(paths.projectMd, project);
  await careful.core.report({ outcome: 'complete', summary: 'Drafted' });
  const request = careful.core.current.approvalQueue.find((item) => item.kind === 'project');
  await careful.core.resolveApproval(request.id, 'approved', '', 'test');
  await careful.core.next();
  careful.map.set('research/assets/main_theorem.md', asset('', { uses_definitions: ['natural'] }));
  careful.map.set('research/definitions/natural.md', definition('A natural number is a member of N.'));
  await careful.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await careful.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await careful.core.next()).stage, 'waiting');
  assert.ok(careful.core.current.approvalQueue.some((item) => item.kind === 'definition' && item.target === 'natural'));
});

test('auto mode on project goals skips review_project; off by default', async () => {
  const off = fixture();
  off.map.set(SETTINGS, auto());
  await off.core.start('claude', { goal: 'Prove it.' });
  off.map.set(paths.projectMd, project);
  assert.equal((await off.core.report({ outcome: 'complete', summary: 'Drafted' })).stage, 'review_project');
  const on = fixture();
  on.map.set(SETTINGS, auto({ project: true }));
  await on.core.start('claude', { goal: 'Prove it.' });
  on.map.set(paths.projectMd, project);
  const result = await on.core.report({ outcome: 'complete', summary: 'Drafted' });
  assert.equal(result.stage, 'select');
  assert.equal((await on.core.next()).stage, 'scaffold');
});

test('a state reload during an auto approval does not re-approve the project forever', async () => {
  const f = fixture();
  f.map.set(SETTINGS, auto({ project: true }));
  await f.core.start('claude', { goal: 'Prove it.' });
  f.map.set(paths.projectMd, project);
  // A file watcher in the extension reloads the core mid-approval, while state.json still holds the request.
  const write = f.files.writeFile;
  let approvalWrites = 0;
  let reloaded = false;
  f.files.writeFile = async (file, content) => {
    await write(file, content);
    if (file !== 'research/approvals/project.json') return;
    if (++approvalWrites > 5) throw new Error('project approval rewritten in a loop');
    if (!reloaded) { reloaded = true; await f.core.load(); }
  };
  const result = await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  assert.equal(reloaded, true);
  assert.equal(approvalWrites, 1);
  assert.equal(result.stage, 'select');
  assert.equal(f.core.current.approvalQueue.length, 0);
});

test('peek reads the state without replacing the one in use', async () => {
  const f = fixture();
  await f.core.start('claude', { goal: 'Prove it.' });
  const inUse = f.core.current;
  const peeked = await f.core.peek();
  assert.equal(peeked.runId, inUse.runId);
  assert.equal(f.core.current, inUse);
});

test('counterexamples are confirmed automatically only when switched on', async () => {
  for (const enabled of [false, true]) {
    const f = fixture();
    f.map.set(SETTINGS, auto({ counterexamples: enabled }));
    await f.core.start('claude', { goal: 'Investigate.' });
    f.map.set(paths.projectMd, project);
    await f.core.report({ outcome: 'complete', summary: 'Drafted' });
    await f.core.resolveApproval(f.core.current.approvalQueue[0].id, 'approved', '', 'test');
    await f.core.next();
    f.map.set('research/assets/main_theorem.md', asset());
    await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
    await f.core.report({ outcome: 'none', summary: 'No sources' });
    assert.equal((await f.core.next()).stage, 'search');
    writeRound(f, { status: 'survived' });
    await f.core.report({ outcome: 'searched', summary: 'Found' });
    const exampleFile = `research/assets/${f.core.current.current.counterexampleId}.md`;
    f.map.set(exampleFile, f.map.get(exampleFile) + '\n## Verdict\n\nconfirmed\n');
    await f.core.report({ outcome: 'confirmed', summary: 'Checked' });
    if (enabled) {
      assert.equal(status(f, 'research/assets/main_theorem.md'), 'deprecated');
      assert.equal((await f.core.next()).stage, 'draft_project');
    } else {
      assert.equal((await f.core.next()).stage, 'waiting');
      assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'counterexample'));
    }
  }
});

test('a dependency change puts its dependants on hold until the researcher approves them', async () => {
  const f = fixture();
  f.map.set(SETTINGS, auto());
  await driveToFalsify(f, {
    'research/assets/main_theorem.md': asset('', { depends_on: ['key_lemma'] }),
    'research/assets/key_lemma.md': node('remark', 'Key remark', 'A remark.'),
  });
  await prove(f);
  assert.equal(record(f, 'main_theorem').source, 'auto');
  f.map.set('research/assets/key_lemma.md', f.map.get('research/assets/key_lemma.md').replace('A remark.', 'A stronger remark.'));
  assert.deepEqual((await f.core.reconcile('key_lemma')).sort(), ['key_lemma', 'main_theorem']);
  assert.equal((await f.core.next()).stage, 'waiting');
  const held = f.core.current.approvalQueue.find((item) => item.target === 'main_theorem');
  assert.match(held.reason, /auto mode: needs your review/);
  const lemma = f.core.current.approvalQueue.find((item) => item.target === 'key_lemma');
  await f.core.resolveApproval(lemma.id, 'approved', '', 'test');
  // The proof stood on the old statement of key_lemma, so it stays with the researcher.
  assert.ok(f.core.current.approvalQueue.some((item) => item.target === 'main_theorem'));
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.target === 'main_theorem').id, 'approved', '', 'test');
  assert.equal(JSON.parse(f.map.get('.research-assistant-loop/auto-holds.json'))['asset:main_theorem'], undefined);
  assert.equal((await f.core.next()).stage, 'ready');
});

test('a proof no plan vouches for, and a disguised citation, are left to the researcher', async () => {
  const f = fixture();
  await driveToFalsify(f);
  f.map.set(SETTINGS, auto());
  f.map.set('research/assets/main_theorem.md', asset('\n## Proof\n\nWritten outside any plan.\n'));
  assert.equal((await f.core.requestApproval('asset', 'main_theorem', 'Proof written.')).status, 'queued');
  const disguised = await f.core.requestApproval('citation', 'main_theorem', 'Known from the literature.');
  assert.equal(disguised.status, 'queued');
  assert.equal(status(f, 'research/assets/main_theorem.md'), 'draft');
});

test('requestApproval reports approvals that are already current', async () => {
  const f = fixture();
  await driveToFalsify(f);
  await prove(f);
  const request = f.core.current.approvalQueue.find((item) => item.target === 'main_theorem');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.requestApproval('asset', 'main_theorem', 'again')).status, 'already_approved');
  assert.equal(f.core.current.approvalQueue.length, 0);
});

test('invalid settings JSON means no auto approval', async () => {
  const f = fixture();
  await driveToFalsify(f);
  f.map.set(SETTINGS, '{"autoApprove": {"enabled": true,');
  await prove(f);
  assert.equal(status(f, 'research/assets/main_theorem.md'), 'draft');
});

test('failed-plan limit and iteration cap come from the loop settings', async () => {
  const f = fixture();
  await driveToFalsify(f);
  f.map.set(SETTINGS, JSON.stringify({ version: 1, maxFailedPlans: 2 }));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const difference = attempt > 1 ? '\n## Difference from failed plans\n\n- attempt_1: different route\n' : '';
    f.map.set(`research/plans/attempt_${attempt}.md`, plan(`attempt_${attempt}`, 'pending', difference));
    await f.core.report({ outcome: 'complete', summary: 'Planned', planId: `attempt_${attempt}` });
    f.map.set(`research/plans/attempt_${attempt}.md`, plan(`attempt_${attempt}`, 'failed', difference));
    const result = await f.core.report({ outcome: 'failed', summary: 'Obstructed' });
    if (attempt === 1) assert.match(result.message, /\(1\/2\)/);
    else assert.match(result.message, /2 approaches failed for main_theorem \(limit 2\)/);
  }
  assert.equal(f.core.current.pendingQuestion.kind, 'blocked');

  const settingsCap = fixture({ [SETTINGS]: JSON.stringify({ version: 1, iterationCap: 7 }) }, {});
  await settingsCap.core.start('codex');
  assert.equal(settingsCap.core.current.autopilot.iterationCap, 7);
  await settingsCap.core.setIterationCap(3);
  assert.equal(JSON.parse(settingsCap.map.get('.research-assistant-loop/state.json')).autopilot.iterationCap, 3);
  const override = fixture({ [SETTINGS]: JSON.stringify({ version: 1, iterationCap: 7 }) }, { iterationCap: 2 });
  await override.core.start('codex');
  assert.equal(override.core.current.autopilot.iterationCap, 2);
});
