const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const { decisionDocs, decisionData, handoffTexts, ideaRaw, logRecords } = require('./records-fixtures.cjs');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { normalizeLoopSettings, applyLoopPatch, validateSettingsPatch, rigorPreset, RIGOR_PRESETS, RIGOR_FIELDS, CHECK_KEYS, AWAY_KEYS, ROUTE_KEYS, involvement, withInvolvement, DEFAULT_LOOP_SETTINGS } = load('../src/domain/loopSettings.ts');
const { RIGOR_KEYS, RIGOR_OPTIONS } = load('../src/models/settings.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n';
const SETTINGS = '.research-assistant-loop/settings.json';
const settings = (rigor = {}, extra = {}) => JSON.stringify({ version: 1, routeWidth: 0, rigor: { verifyExtracted: 'off', ...rigor }, ...extra });

const asset = (id, extra = {}, status = 'draft', proof = '') => matter.stringify(`\n## Statement\n\nFor every natural number n, ${id} holds.\n${proof}`, { type: extra.type ?? 'theorem', title: id, status, source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const definition = (title, text, extra = {}, status = 'draft') => matter.stringify(`\n${text}\n`, { type: 'definition', title: `Definition (${title})`, status, depends_on: [], ...extra });
const plan = (id, target, status = 'pending', difference = '') => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\nProve it.\n\n## Plan\n\n1. [ ] Apply reflexivity.\n\n## Verification\n\nCheck it.\n${difference}${status === 'failed' ? '\n## Failure\n\nThis approach cannot establish it.\n' : ''}`, { type: 'plan', title: id, status, target_asset: target, inspired_by: [], tags: [] });

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
function fixture(rigor = {}, extra = {}) {
  const files = memoryFiles({ 'research/project.md': '# Project\n', 'research/papers.md': '# Papers\n', [SETTINGS]: settings(rigor, extra) });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map };
}

/** Goals approved by hand, scaffold writes `scaffold`, sources finds none; returns the next selection. */
async function driveToSelection(f, scaffold) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  for (const [file, content] of Object.entries(scaffold)) f.map.set(file, content);
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  return f.core.next();
}

const decisions = (f) => decisionData(f.map);

// ---------- settings ----------

test('how thorough: Careful by default, Fast as a preset over the checks, every key validated and described', () => {
  assert.equal(rigorPreset(DEFAULT_LOOP_SETTINGS.rigor), 'careful');
  assert.equal(rigorPreset({ ...DEFAULT_LOOP_SETTINGS.rigor, ...RIGOR_PRESETS.fast }), 'fast');
  assert.equal(rigorPreset({ ...DEFAULT_LOOP_SETTINGS.rigor, refuteSearch: 'off' }), 'custom');
  // What happens when the researcher does not respond is set apart from the checks, so it never changes the preset.
  assert.equal(rigorPreset({ ...DEFAULT_LOOP_SETTINGS.rigor, whenStuck: 'retry', unansweredQuestions: 'default' }), 'careful');
  assert.deepEqual([...CHECK_KEYS, ...AWAY_KEYS, ...ROUTE_KEYS].sort(), [...RIGOR_KEYS].sort());
  // How routes are planned is its own group too, so it never changes the preset either.
  assert.equal(rigorPreset({ ...DEFAULT_LOOP_SETTINGS.rigor, reviewRoutes: 'off', lemmaRoutes: 'on' }), 'careful');
  for (const key of RIGOR_KEYS) {
    assert.deepEqual(Object.keys(RIGOR_FIELDS[key].options).sort(), [...RIGOR_OPTIONS[key]].sort(), key);
    assert.ok(RIGOR_FIELDS[key].label && RIGOR_FIELDS[key].hint, key);
  }
  const { settings: normalized, problems } = normalizeLoopSettings({ rigor: { refuteSearch: 'sometimes', whenStuck: 'retry' } });
  assert.equal(normalized.rigor.refuteSearch, 'all');
  assert.equal(normalized.rigor.whenStuck, 'retry');
  assert.match(problems[0], /rigor\.refuteSearch/);
  assert.deepEqual(validateSettingsPatch({ loop: { rigor: { onDependencyChange: 'ignore' } } }, []), { 'loop.rigor.onDependencyChange': 'Choose one of: revert, flag.' });
  assert.equal(applyLoopPatch(DEFAULT_LOOP_SETTINGS, { rigor: { refuteSearch: 'main' } }).rigor.agreeDefinitions, 'main', 'a patch keeps the other keys');
});

test('how involved: one level over the auto-approve and autonomy switches, keeping the rule choices', () => {
  const base = DEFAULT_LOOP_SETTINGS;
  assert.equal(involvement(base), 'review');
  const routine = withInvolvement({ ...base, autoApprove: { ...base.autoApprove, project: true } }, 'routine');
  assert.deepEqual([routine.autoApprove.enabled, routine.autonomy.enabled, involvement(routine)], [true, false, 'routine']);
  const alone = withInvolvement(routine, 'alone');
  assert.deepEqual([alone.autonomy.enabled, involvement(alone)], [true, 'alone']);
  const back = withInvolvement(alone, 'review');
  assert.deepEqual([back.autoApprove.enabled, back.autonomy.enabled, involvement(back)], [false, false, 'review']);
  assert.equal(withInvolvement(back, 'routine').autoApprove.project, true, 'returning to routine restores the rule checkboxes');
});

// ---------- 1. counterexample search before proving ----------

test('counterexample search: every result by default, main results only, or never', async () => {
  const scaffold = { 'research/assets/main_theorem.md': asset('main_theorem', { depends_on: ['helper'] }), 'research/assets/helper.md': asset('helper', { type: 'lemma' }) };
  const all = await driveToSelection(fixture(), scaffold);
  assert.deepEqual([all.stage, all.brief.assetId], ['search', 'helper']);
  const main = fixture({ refuteSearch: 'main' });
  const mainOnly = await driveToSelection(main, scaffold);
  assert.deepEqual([mainOnly.stage, mainOnly.brief.assetId], ['plan', 'helper'], 'a supporting lemma goes straight to planning');
  const off = await driveToSelection(fixture({ refuteSearch: 'off' }), { 'research/assets/main_theorem.md': asset('main_theorem') });
  assert.deepEqual([off.stage, off.brief.assetId], ['plan', 'main_theorem']);
});

// ---------- 2. agree on definitions before proving ----------

test('definitions a main result uses are agreed before any proof work (Careful), or checked at the end (Fast)', async () => {
  const scaffold = { 'research/assets/main_theorem.md': asset('main_theorem', { uses_definitions: ['natural'] }), 'research/definitions/natural.md': definition('natural', 'A natural number is a member of N.') };
  const careful = fixture();
  const waiting = await driveToSelection(careful, scaffold);
  assert.equal(waiting.stage, 'waiting');
  const request = careful.core.current.approvalQueue.find((item) => item.kind === 'definition' && item.target === 'natural');
  assert.match(request.reason, /agree on it before the proofs start/);
  assert.deepEqual(careful.core.current.waitingOn, [{ kind: 'approval', target: 'natural', detail: 'definition' }]);
  await careful.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await careful.core.next()).stage, 'search');
  const fast = await driveToSelection(fixture({ agreeDefinitions: 'off' }), scaffold);
  assert.equal(fast.stage, 'search');
});

// ---------- 4. a definition used but missing ----------

test('a missing definition goes back to scaffold for a draft; "wait" holds its users until it is agreed', async () => {
  for (const policy of ['wait', 'continue']) {
    const f = fixture({ missingDefinitions: policy, agreeDefinitions: 'off' });
    await driveToSelection(f, { 'research/assets/main_theorem.md': asset('main_theorem') });
    // The researcher edits the statement to use a notion nobody wrote down yet.
    f.map.set('research/assets/main_theorem.md', asset('main_theorem', { uses_definitions: ['natural'] }));
    await f.core.setStage?.('select');
    const scaffold = await f.core.next();
    assert.equal(scaffold.stage, 'scaffold', policy);
    assert.deepEqual(f.core.current.scaffoldBrief.missingDefinitions, ['natural']);
    assert.match(scaffold.instruction, /These definitions are used but have no file: natural/);
    f.map.set('research/definitions/natural.md', definition('natural', 'A natural number is a member of N.'));
    await f.core.report({ outcome: 'complete', summary: 'Drafted the definition' });
    await f.core.report({ outcome: 'none', summary: 'No sources' });
    const after = await f.core.next();
    if (policy === 'wait') {
      assert.equal(after.stage, 'waiting');
      assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'definition' && item.target === 'natural'));
    } else assert.equal(after.stage, 'search');
  }
});

// ---------- 3. when something a result rests on changes ----------

async function approvedChain(rigor) {
  const f = fixture(rigor);
  f.map.set('research/definitions/natural.md', definition('natural', 'A natural number is a member of N.', {}, 'approved'));
  f.map.set('research/definitions/even.md', definition('even', 'An even number is 2k for a natural k.', { depends_on: ['natural'] }, 'approved'));
  f.map.set('research/assets/main_theorem.md', asset('main_theorem', { uses_definitions: ['even'] }, 'approved', '\n## Proof\n\nBy definition.\n'));
  for (const [kind, id] of [['definition', 'natural'], ['definition', 'even'], ['asset', 'main_theorem']]) assert.equal(await f.core.recordExisting(kind, id, 'test'), true);
  f.map.set('research/definitions/natural.md', definition('natural', 'A natural number is a positive member of N.', {}, 'approved'));
  return f;
}

test('a changed definition sends everything downstream back to review (Careful) or marks it for re-check (Fast)', async () => {
  const careful = await approvedChain({});
  assert.deepEqual((await careful.core.reconcile('natural')).sort(), ['even', 'main_theorem', 'natural'], 'two levels down too');
  for (const file of ['research/definitions/even.md', 'research/assets/main_theorem.md']) assert.equal(matter(careful.map.get(file)).data.status, 'draft');

  const fast = await approvedChain({ onDependencyChange: 'flag' });
  assert.deepEqual(await fast.core.reconcile('natural'), ['natural'], 'only the edited node itself loses its approval');
  assert.equal(matter(fast.map.get('research/assets/main_theorem.md')).data.status, 'approved');
  assert.deepEqual(await fast.core.recheckFlags(), { even: 'natural', main_theorem: 'natural' });
  await fast.core.confirmRecheck('main_theorem');
  assert.deepEqual(await fast.core.recheckFlags(), { even: 'natural' });
});

// ---------- 5 and 6. stuck without a direction; unanswered questions ----------

async function stuck(rigor) {
  const f = fixture({ refuteSearch: 'off', ...rigor }, { maxFailedPlans: 1 });
  assert.equal((await driveToSelection(f, { 'research/assets/main_theorem.md': asset('main_theorem') })).stage, 'plan');
  return f;
}
async function fail(f, id, difference = '') {
  f.map.set(`research/plans/${id}.md`, plan(id, 'main_theorem', 'pending', difference));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: id });
  f.map.set(`research/plans/${id}.md`, plan(id, 'main_theorem', 'failed', difference));
  await f.core.report({ outcome: 'failed', summary: 'Obstructed' });
}

test('stuck without a direction: set aside (Careful), or one new approach by the agent first (Fast)', async () => {
  const careful = await stuck({});
  await fail(careful, 'attempt_1');
  await careful.core.autoResolveQuestion(careful.core.current.pendingQuestion.id);
  assert.equal(careful.core.current.parked.main_theorem.reason, 'three_failures');

  const fast = await stuck({ whenStuck: 'retry' });
  await fail(fast, 'attempt_1');
  await fast.core.autoResolveQuestion(fast.core.current.pendingQuestion.id);
  assert.equal(fast.core.current.parked.main_theorem, undefined);
  assert.equal(fast.core.current.stage, 'plan');
  assert.ok(decisions(fast).some((decision) => decision.kind === 'direction' && decision.reason === 'agent_retry'));
  await fail(fast, 'attempt_2', '\n## Difference from failed plans\n\n- attempt_1: a different route\n');
  await fast.core.autoResolveQuestion(fast.core.current.pendingQuestion.id);
  assert.equal(fast.core.current.parked.main_theorem.reason, 'three_failures', 'only one retry per stuck episode');
});

test('a question the loop raises carries the timeout; overdue it waits (Careful) or resolves (Fast)', async () => {
  const careful = await stuck({});
  await fail(careful, 'attempt_1');
  const question = careful.core.current.pendingQuestion;
  assert.equal(question.timeoutSec, DEFAULT_LOOP_SETTINGS.questionTimeoutSeconds);
  const later = Date.parse(question.createdAt) + 3600_000;
  assert.equal(await careful.core.resolveOverdueQuestion(later), false);
  assert.ok(careful.core.current.pendingQuestion, 'still waiting for the researcher');

  const fast = await stuck({ unansweredQuestions: 'default' });
  await fail(fast, 'attempt_1');
  assert.equal(await fast.core.resolveOverdueQuestion(Date.parse(fast.core.current.pendingQuestion.createdAt) + 1000), false, 'not overdue yet');
  assert.equal(await fast.core.resolveOverdueQuestion(Date.parse(fast.core.current.pendingQuestion.createdAt) + 3600_000), true);
  assert.equal(fast.core.current.pendingQuestion, undefined);
  assert.equal(fast.core.current.parked.main_theorem.reason, 'three_failures');
});

test('the agent’s brief names every auto rule in force, specifications included, and the researcher’s rigor', async () => {
  const f = fixture({ refuteSearch: 'main' }, { autoApprove: { enabled: true, specifications: true } });
  await f.core.start('claude', { goal: 'Prove it.' });
  await f.core.loopSettings();
  const brief = f.core.briefStatus();
  assert.match(brief, /approves [^\n]*specifications/);
  assert.match(brief, /counterexample search for main results only/);
});
