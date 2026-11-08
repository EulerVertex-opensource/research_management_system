const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { normalizeLoopSettings, applyLoopPatch, validateSettingsPatch, DEFAULT_LOOP_SETTINGS } = load('../src/domain/loopSettings.ts');
const { stopDecision } = load('../src/services/ResearchLoopHooks.ts');
const { computeLoopHealth } = load('../src/domain/loopHealth.ts');
const { buildGraphPayload } = load('../src/services/GraphViewModel.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n';
const SETTINGS = '.research-assistant-loop/settings.json';

const asset = (id, extra = {}) => matter.stringify(`\n## Statement\n\nFor every natural number n, ${id} holds.\n`, { type: 'theorem', title: id, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const plan = (id, target, status, difference = '') => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\nProve it.\n\n## Plan\n\n1. [ ] Apply reflexivity.\n\n## Verification\n\nCheck it.\n${difference}${status === 'failed' ? '\n## Failure\n\nThis approach cannot establish it.\n' : ''}`, { type: 'plan', title: id, status, target_asset: target, inspired_by: [], tags: [] });

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
    listDirs: async (folder) => [...new Set([...map.keys()].filter((file) => file.startsWith(`${folder}/`)).map((file) => `${folder}/${file.slice(folder.length + 1).split('/')[0]}`).filter((dir) => [...map.keys()].some((file) => file.startsWith(`${dir}/`))))].sort(),
    deleteFile: async (file) => { map.delete(file); },
  };
}

let counter = 0;
function fixture(extra = {}, clock) {
  const settings = { version: 1, rigor: { refuteSearch: 'off', verifyProofs: 'off' }, autonomy: { enabled: true }, maxFailedPlans: 1, ...extra };
  const files = memoryFiles({ 'research/project.md': '# Project\n', 'research/papers.md': '# Papers\n', [SETTINGS]: JSON.stringify(settings) });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5, ...(clock ? { now: () => clock.now } : {}) });
  return { files, core, map: files.map };
}

/** Autonomous mode accepts the goals itself; scaffold writes one main theorem, sources finds none. */
async function driveToPlan(f) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  const drafted = await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  assert.match(drafted.message, /approved automatically/, 'every auto-approve rule applies, the project one too');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', asset('main_theorem'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'plan');
}

async function fail(f, id, difference = '') {
  f.map.set(`research/plans/${id}.md`, plan(id, 'main_theorem', 'pending', difference));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: id });
  f.map.set(`research/plans/${id}.md`, plan(id, 'main_theorem', 'failed', difference));
  return f.core.report({ outcome: 'failed', summary: 'Obstructed' });
}

const decisions = (f) => [...f.map.entries()].filter(([file]) => file.startsWith('research/decisions/')).map(([, raw]) => matter(raw).data);

test('autonomous mode settings: off by default, fail closed, patched and validated', () => {
  assert.equal(DEFAULT_LOOP_SETTINGS.autonomy.enabled, false);
  assert.equal(DEFAULT_LOOP_SETTINGS.autonomyHours, 0, 'no time limit by default');
  const bad = normalizeLoopSettings({ autonomy: { enabled: 'yes' } });
  assert.equal(bad.settings.autonomy.enabled, false);
  assert.match(bad.problems[0], /autonomy is malformed/);
  assert.equal(applyLoopPatch(DEFAULT_LOOP_SETTINGS, { autonomy: { enabled: true }, autonomyBudget: 12 }).autonomy.enabled, true);
  assert.deepEqual(validateSettingsPatch({ loop: { autonomy: { enabled: 1 } } }, []), { 'loop.autonomy.enabled': 'Expected on or off.' });
  assert.equal(normalizeLoopSettings({ autonomyBudget: 5000 }).settings.autonomyBudget, 1000, 'clamped to its range');
});

test('autonomous mode never asks: a question is kept as an idea and the agent goes on', async () => {
  const f = fixture();
  await driveToPlan(f);
  const { message } = await f.core.report({ outcome: 'question', summary: 'Which induction?', question: 'Induct on n or on 2n? By default I induct on n.' });
  assert.match(message, /Go on with the default you stated/);
  assert.equal(f.core.current.pendingQuestion, undefined);
  const ideas = [...f.map.entries()].filter(([file]) => file.startsWith('research/ideas/')).map(([, raw]) => matter(raw));
  assert.ok(ideas.some((idea) => idea.data.idea_kind === 'question' && /Autonomous mode/.test(idea.content)));
  assert.match((await f.core.next()).instruction, /Autonomous mode \(set by the researcher\)/);
});

test('a stuck result waits on the agent, which gives it more attempts with its own direction', async () => {
  const f = fixture();
  await driveToPlan(f);
  const stuck = await fail(f, 'attempt_1');
  assert.equal(f.core.current.pendingQuestion, undefined, 'no blocked question for the researcher');
  assert.equal(f.core.current.autonomy.deciding, 'main_theorem');
  assert.match(stuck.message, /budget allocate main_theorem <n>/);
  assert.match((await f.core.next()).instruction, /Decide yourself, without the researcher/);
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_x' }), /Decide yourself/);

  await assert.rejects(f.core.allocate('main_theorem', 2, ''), /--reason/);
  await assert.rejects(f.core.allocate('main_theorem', 500, 'Too much.'), /from 1 to 29/);
  await f.core.allocate('main_theorem', 2, 'Reflexivity fails at n = 0; split off the base case.');
  assert.equal(f.core.current.autonomy.deciding, undefined);
  assert.equal(f.core.current.stage, 'plan');
  assert.ok(decisions(f).some((decision) => decision.kind === 'direction' && decision.reason === 'autonomous' && decision.rounds === 2));
  const pack = await f.core.contextPack();
  assert.match(pack.text, /Your own latest direction \(autonomous mode\), which this plan must follow: Reflexivity fails at n = 0/);

  const difference = '\n## Difference from failed plans\n\n- attempt_1: a different route\n';
  await fail(f, 'attempt_2', difference);
  assert.equal(f.core.current.autonomy.deciding, undefined, 'the new allotment is two attempts');
  await fail(f, 'attempt_3', '\n## Difference from failed plans\n\n- attempt_1: a different route\n- attempt_2: another route\n');
  assert.equal(f.core.current.autonomy.deciding, 'main_theorem');
  assert.equal(f.core.current.autonomy.spent, 3);
});

test('no new approach in sight: report none spends no attempt and sends the agent to decide', async () => {
  const f = fixture({ maxFailedPlans: 3 });
  await driveToPlan(f);
  await fail(f, 'attempt_1');
  assert.equal(f.core.current.autonomy.spent, 1);
  await assert.rejects(f.core.report({ outcome: 'none', summary: '' }), /--summary/);
  const none = await f.core.report({ outcome: 'none', summary: 'Every route needs the base case, which reflexivity cannot reach.' });
  assert.equal(f.core.current.autonomy.spent, 1, 'nothing was executed, so nothing is spent');
  assert.equal(f.core.current.autonomy.deciding, 'main_theorem', 'the agent decides: a new direction or set it aside');
  assert.match(none.message, /No new approach is in sight for main_theorem: Every route needs the base case/);
  assert.equal(f.core.current.pendingQuestion, undefined);
  assert.equal([...f.map.keys()].filter((file) => file.startsWith('research/plans/')).length, 1, 'no failed plan is recorded for it');

  // Its own direction, and then still no plan: the result is set aside instead of spending an attempt on a filler plan.
  await f.core.allocate('main_theorem', 2, 'Split off the base case.');
  const again = await f.core.report({ outcome: 'none', summary: 'Splitting off the base case leaves the same gap.' });
  assert.match(again.message, /set aside with your note/);
  assert.equal(f.core.current.parked.main_theorem.reason, 'agent_gave_up');
  assert.equal(f.core.current.parked.main_theorem.note, 'Splitting off the base case leaves the same gap.');
  assert.equal(f.core.current.autonomy.spent, 1);
});

test('report none with a plan written is refused, and a pending plan cannot be skipped', async () => {
  const f = fixture();
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1', 'main_theorem', 'pending'));
  await assert.rejects(f.core.report({ outcome: 'none', summary: 'Nothing new.' }), /report complete --plan/);
});

test('without autonomous mode, report none at the plan stage asks the researcher for a direction', async () => {
  const f = fixture({ autonomy: { enabled: false }, autoApprove: { enabled: true, project: true } });
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.next();
  f.map.set('research/assets/main_theorem.md', asset('main_theorem'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'plan');
  const none = await f.core.report({ outcome: 'none', summary: 'Every route needs the base case.' });
  assert.equal(none.stage, 'plan');
  assert.equal(f.core.current.pendingQuestion.kind, 'blocked');
  assert.match(f.core.current.pendingQuestion.prompt, /No new approach is in sight for main_theorem/);
});

test('setting a result aside leaves nothing to do alone: the loop hands back with a handoff', async () => {
  const f = fixture({ autonomyRevisions: 0 });
  await driveToPlan(f);
  await fail(f, 'attempt_1');
  await f.core.park('main_theorem', 'agent_gave_up', 'Reflexivity cannot reach n = 0.');
  assert.equal(f.core.current.autonomy.deciding, undefined);
  const next = await f.core.next();
  assert.match(next.instruction, /Autonomous run finished: nothing is left that it can do on its own/);
  assert.equal(f.core.current.status, 'paused');
  assert.ok([...f.map.keys()].some((file) => file.startsWith('research/handoffs/')), 'a handoff for the researcher');
  const health = computeLoopHealth({ state: f.core.current, nodes: [], edges: [], required: [], now: new Date().toISOString() });
  assert.match(health.headline, /autonomous run is over/);
  assert.equal(stopDecision(f.core.current, { session_id: 's' }, undefined).block, false);

  await f.core.resume();
  assert.equal(f.core.current.autonomy, undefined, 'resuming starts a new run');
  await f.core.next();
  assert.deepEqual([f.core.current.autonomy.spent, f.core.current.status], [0, 'paused'], 'still nothing to do alone, so it hands back again');
});

test('a new goal after a hand-back starts a new autonomous run, and resume and extend reset the continuation count', async () => {
  const f = fixture({ autonomyRevisions: 0, autonomyConjectures: 0 });
  await driveToPlan(f);
  await fail(f, 'attempt_1');
  await f.core.park('main_theorem', 'agent_gave_up', 'Reflexivity cannot reach n = 0.');
  await f.core.next();
  assert.ok(f.core.current.autonomy.handedOverAt, 'handed back');
  // A chat that kept the autonomous run going for a long time has a large count; it must not end the next run at its first Stop.
  f.core.current.autopilot.sessions.s = { blocks: 44, lastSignature: '', lastBlockAt: '' };
  await f.core.extend('Also prove a weaker form.');
  assert.equal(f.core.current.status, 'running');
  assert.equal(f.core.current.autonomy, undefined, 'the handed-back run is over');
  assert.deepEqual(f.core.current.autopilot.sessions, {});
  await f.core.next();
  assert.ok(f.core.current.autonomy && !f.core.current.autonomy.handedOverAt, 'the extension runs autonomously again');
  assert.equal(f.core.current.autonomy.spent, 0);
  assert.equal(stopDecision(f.core.current, { session_id: 's' }, 'go').counted, false, 'an autonomous run does not count toward the cap');

  await f.core.pause('Paused by the researcher.');
  f.core.current.autopilot.sessions.s = { blocks: 7, lastSignature: '', lastBlockAt: '' };
  await f.core.resume();
  assert.deepEqual(f.core.current.autopilot.sessions, {});
});

test('status reports the researcher\'s autonomous budget, not the default, right after loading', async () => {
  const f = fixture({ autonomyBudget: 100 });
  await driveToPlan(f);
  const reopened = new ResearchLoopCore(f.files, paths, { id: () => `id-${++counter}` });
  await reopened.load();
  assert.match(reopened.briefStatus(), /of 100 attempts/);
});

test('the budget ends the run, and the Stop hook ignores the per-session cap until then', async () => {
  const f = fixture({ autonomyBudget: 2, maxFailedPlans: 5 });
  await driveToPlan(f);
  const state = f.core.current;
  state.autopilot.sessions.s = { blocks: 99, lastSignature: '', lastBlockAt: '' };
  assert.equal(stopDecision(state, { session_id: 's' }, 'go').block, true, 'the budget, not the cap, bounds an autonomous run');
  await fail(f, 'attempt_1');
  const last = await fail(f, 'attempt_2', '\n## Difference from failed plans\n\n- attempt_1: a different route\n');
  assert.match(last.message, /Autonomous run finished: it spent its budget of 2 attempt\(s\)/);
  assert.equal(f.core.current.status, 'paused');
  assert.equal(stopDecision(f.core.current, { session_id: 's' }, 'go').block, false);
});

test('the time limit ends the run at the next step', async () => {
  const clock = { now: '2026-10-25T08:00:00.000Z' };
  const f = fixture({ autonomyHours: 2 }, clock);
  await driveToPlan(f);
  clock.now = '2026-10-25T10:30:00.000Z';
  assert.match((await f.core.next()).instruction, /time limit of 2 hour\(s\)/);
  assert.equal(f.core.current.status, 'paused');
});

test('a question asked before autonomous mode was turned on is settled the autonomous way', async () => {
  const f = fixture({ autonomy: { enabled: false } });
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.askQuestion('discussion', 'Use the strong form? By default, yes.');
  f.map.set(SETTINGS, JSON.stringify({ version: 1, autonomy: { enabled: true } }));
  await f.core.next();
  assert.equal(f.core.current.pendingQuestion, undefined);
  assert.ok(f.core.current.autonomy, 'the run starts');
});

const weaker = project.replace('  - id: main_theorem\n', '  - id: main_theorem\n  - id: weaker_theorem\n');

async function setAside(f, id = 'main_theorem', attempt = 'attempt_1') {
  f.map.set(`research/plans/${attempt}.md`, plan(attempt, id, 'pending'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: attempt });
  f.map.set(`research/plans/${attempt}.md`, plan(attempt, id, 'failed'));
  await f.core.report({ outcome: 'failed', summary: 'Obstructed' });
  await f.core.park(id, 'agent_gave_up', 'No route past the base case.');
  return f.core.next();
}

test('with results set aside, the agent reassesses the goals itself: it adds a weaker goal and keeps the original', async () => {
  const f = fixture();
  await driveToPlan(f);
  const revise = await setAside(f);
  assert.equal(revise.stage, 'draft_project');
  assert.equal(f.core.current.status, 'running');
  assert.equal(f.core.current.researcherInput.kind, 'autonomous_revision');
  assert.match(revise.instruction, /^Stage draft_project: an autonomous reassessment of the goals\.\nAutonomous reassessment 1 of 2 \(the researcher is away\): nothing is actionable, but 1 required result\(s\) are open\./, 'the reassessment leads the instruction');
  assert.match(revise.instruction, /Only 1 set-aside result\(s\) stand in the way, the whole frontier/);
  assert.ok(revise.instruction.indexOf('report none') < revise.instruction.indexOf('keep every existing required_results entry'), 'the choice comes before the extension rules');
  assert.match(f.map.get('.research-assistant-loop/context/assessment.md'), /- main_theorem \(agent gave up: No route past the base case\.\); blocks itself/, 'the full report is in a file');
  assert.match(revise.instruction, /- main_theorem \(agent gave up: No route past the base case\.\); blocks itself; set aside \d{4}-\d\d-\d\d, nothing proved since/);
  assert.match(revise.instruction, /keep every existing required_results entry \(main_theorem\)/);
  assert.deepEqual(f.core.current.extension.baselineRequired, ['main_theorem']);

  f.map.set(paths.projectMd, project.replace('  - id: main_theorem\n', '  - id: weaker_theorem\n'));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Dropped it' }), /keep the existing required results main_theorem/);
  f.map.set(paths.projectMd, weaker);
  const drafted = await f.core.report({ outcome: 'complete', summary: 'Added the weaker theorem for n >= 1.' });
  assert.match(drafted.message, /approved automatically/);
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/weaker_theorem.md', asset('weaker_theorem'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  const next = await f.core.next();
  assert.deepEqual([next.stage, next.brief.assetId], ['plan', 'weaker_theorem']);
  assert.ok(f.core.current.parked.main_theorem, 'the original stays set aside for the researcher');

  // Setting the new goal aside too is something new, so it uses the second reassessment; the third time the loop hands back.
  const second = await setAside(f, 'weaker_theorem', 'attempt_w1');
  assert.deepEqual([second.stage, f.core.current.autonomy.revisions], ['draft_project', 2]);
  assert.match(second.instruction, /Since the last reassessment: set aside weaker_theorem\./);
  assert.match(second.instruction, /Only 2 set-aside result\(s\) stand in the way[^\n]*\n- [a-z_]+ \([^\n]*\n- [a-z_]+ \(/, 'every set-aside result in the way is offered again');
  f.map.set(paths.projectMd, weaker.replace('  - id: weaker_theorem\n', '  - id: weaker_theorem\n  - id: special_case\n'));
  await f.core.report({ outcome: 'complete', summary: 'Added a special case.' });
  await f.core.next();
  f.map.set('research/assets/special_case.md', asset('special_case'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  await f.core.next();
  const last = await setAside(f, 'special_case', 'attempt_s1');
  assert.match(last.instruction, /Autonomous run finished: nothing is left/);
  assert.match([...f.map.entries()].filter(([file]) => file.startsWith('research/handoffs/')).map(([, raw]) => raw).join('\n'), /reassessed what the goals still need 2 time\(s\)/);
});

async function addWeakerGoal(f, deps = []) {
  f.map.set(paths.projectMd, weaker);
  await f.core.report({ outcome: 'complete', summary: 'Added the weaker theorem for n >= 1.' });
  await f.core.next();
  f.map.set('research/assets/weaker_theorem.md', asset('weaker_theorem', { depends_on: deps }));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  return f.core.next();
}

test('after its new goal is proved, the agent reassesses again and brings back a set-aside result with its own direction', async () => {
  const f = fixture();
  await driveToPlan(f);
  await setAside(f);
  await addWeakerGoal(f);
  f.map.set('research/plans/attempt_w1.md', plan('attempt_w1', 'weaker_theorem', 'pending'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_w1' });
  f.map.set('research/plans/attempt_w1.md', plan('attempt_w1', 'weaker_theorem', 'succeeded') + '\n## Outcome\n\nProved.\n');
  f.map.set('research/assets/weaker_theorem.md', asset('weaker_theorem') + '\n## Proof\n\nBy induction from n = 1.\n');
  await f.core.report({ outcome: 'proved', summary: 'Proved it' });
  // A helper the original turns out to need, set aside too: bringing back the original alone is not enough.
  f.map.set('research/assets/helper.md', asset('helper'));
  f.map.set('research/assets/main_theorem.md', asset('main_theorem', { depends_on: ['helper'] }));
  await f.core.park('helper', 'agent_gave_up', 'Needs the base case.');

  const again = await f.core.next();
  assert.deepEqual([again.stage, f.core.current.status, f.core.current.autonomy.revisions], ['draft_project', 'running', 2], 'something was proved since, so the second reassessment runs');
  assert.match(again.instruction, /- main_theorem \(agent gave up: No route past the base case\.\); blocks itself; set aside [\d-]+, proved since: weaker_theorem\n- helper \(agent gave up: Needs the base case\.\); blocks main_theorem; set aside [\d-]+, nothing proved since/, 'what something new may get past comes first');
  assert.match(again.instruction, /Since the last reassessment: proved weaker_theorem; set aside helper\./);

  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Thought about it' }), /Nothing changed: bring back a set-aside result/);
  assert.match(await f.core.allocate('main_theorem', 2, 'The weaker theorem covers n >= 1; only n = 0 is left.'), /comes back with 2 more proof attempt\(s\)/);
  assert.equal(f.core.current.stage, 'draft_project', 'the reassessment goes on until its report');
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Brought back the original' }), /still depend on set-aside helper/);
  await f.core.allocate('helper', 1, 'n = 0 is a direct check.');
  const { message } = await f.core.report({ outcome: 'complete', summary: 'The original needs only n = 0 now; brought it back with its helper.' });
  assert.match(message, /Brought back main_theorem, helper\./);
  assert.deepEqual([f.core.current.extension, f.core.current.researcherInput, f.core.current.parked.main_theorem], [undefined, undefined, undefined]);
  assert.equal(f.map.get(paths.projectMd), weaker, 'the goals are unchanged');
  const next = await f.core.next();
  assert.deepEqual([next.stage, next.brief.assetId], ['plan', 'helper'], 'the dependency goes first');
});

test('with a focus, the reassessment weighs only what stands in its way, and a narrow frontier points to a supplying lemma', async () => {
  const f = fixture();
  await driveToPlan(f);
  await setAside(f);
  await addWeakerGoal(f);
  await assert.rejects(f.core.setFocus(['nowhere']), /not under required_results: nowhere/);
  assert.deepEqual(await f.core.setFocus(['main_theorem']), ['main_theorem']);
  assert.match(f.core.briefStatus(), /Focus \(set by the researcher\): main_theorem/);
  const next = await setAside(f, 'weaker_theorem', 'attempt_w1');
  assert.equal(next.stage, 'draft_project');
  assert.match(next.instruction, /the researcher's focus main_theorem is open \(1 other open required result\(s\) lie outside it\)/);
  assert.match(next.instruction, /Only 1 set-aside result\(s\) stand in the way, the whole frontier/);
  assert.match(next.instruction, /The frontier is narrow: unless an obstruction above is false, the way on is \(b\)/);
  assert.doesNotMatch(next.instruction, /- weaker_theorem \(/, 'a result outside the focus is not offered');
  const asked = await f.core.report({ outcome: 'none', summary: 'No route.' });
  assert.match(asked.message, /one by one: main_theorem\. .*whether a new lemma could supply its missing step/);
  await f.core.setFocus([]);
  assert.equal(f.core.current.focus, undefined);
});

test('with nothing proved or set aside since the last reassessment, the loop hands back even with reassessments left', async () => {
  const f = fixture({ autonomyRevisions: 3 });
  await driveToPlan(f);
  await setAside(f);
  const ended = await addWeakerGoal(f, ['main_theorem']);
  assert.match(ended.instruction, /Autonomous run finished: nothing is left that it can do on its own/);
  assert.deepEqual([f.core.current.status, f.core.current.autonomy.revisions], ['paused', 1]);
});

test('when no sound revision is in sight the agent says so and the loop hands back, goals unchanged', async () => {
  const f = fixture();
  await driveToPlan(f);
  assert.equal((await setAside(f)).stage, 'draft_project');
  await assert.rejects(f.core.report({ outcome: 'none', summary: 'main_theorem: no route.', confirm: true }), /without --confirm first/);
  const asked = await f.core.report({ outcome: 'none', summary: 'Every weakening is either trivial or already known.' });
  assert.equal(asked.stage, 'draft_project', 'a first none does not hand back');
  assert.match(asked.message, /go through the leading set-aside results one by one: main_theorem\./);
  assert.equal(f.core.current.status, 'running');
  await assert.rejects(f.core.report({ outcome: 'none', summary: 'Still nothing.' }), /Add --confirm/);
  await assert.rejects(f.core.report({ outcome: 'none', summary: 'Nothing new.', confirm: true }), /does not mention main_theorem/);
  const { message } = await f.core.report({ outcome: 'none', summary: 'main_theorem: nothing proved since reaches n = 0, and every weakening is trivial.', confirm: true });
  assert.match(message, /no sound revision of the goals \(Every weakening is either trivial or already known\.\)/, 'the hand-back gives the first reason');
  assert.equal(f.core.current.status, 'paused');
  assert.equal(f.core.current.extension, undefined);
  assert.equal(f.core.current.researcherInput, undefined);
  assert.equal(f.map.get(paths.projectMd), project);
});

test('the Overview sees the run: budget while it works, and after hand-back what it proved, set aside, and added', async () => {
  const f = fixture({ autonomyRevisions: 1, autonomyHours: 3 });
  await driveToPlan(f);
  const working = await f.core.autonomySummary();
  assert.equal(working.active, true);
  assert.ok(working.deadline, 'a time limit shows when it hands back');
  await setAside(f);
  f.map.set(paths.projectMd, weaker);
  await f.core.report({ outcome: 'complete', summary: 'Added the weaker theorem for n >= 1.' });
  await f.core.next();
  f.map.set('research/assets/weaker_theorem.md', asset('weaker_theorem'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  await f.core.next();
  f.map.set('research/plans/attempt_w1.md', plan('attempt_w1', 'weaker_theorem', 'pending'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_w1' });
  f.map.set('research/plans/attempt_w1.md', plan('attempt_w1', 'weaker_theorem', 'succeeded') + '\n## Outcome\n\nProved.\n');
  f.map.set('research/assets/weaker_theorem.md', asset('weaker_theorem') + '\n## Proof\n\nBy induction from n = 1.\n');
  await f.core.report({ outcome: 'proved', summary: 'Proved it' });
  const ended = await f.core.next();
  assert.match(ended.instruction, /Autonomous run finished/, 'its one reassessment is used');

  const run = await f.core.autonomySummary();
  assert.equal(run.active, false);
  assert.match(run.reason, /nothing is left that it can do on its own/);
  assert.deepEqual([run.spent, run.revisions, run.revisionLimit], [2, 1, 1]);
  assert.deepEqual(run.spending, [{ id: 'main_theorem', attempts: 1 }, { id: 'weaker_theorem', attempts: 1 }]);
  assert.deepEqual(run.proved, ['weaker_theorem']);
  assert.deepEqual(run.setAside, [{ id: 'main_theorem', note: 'No route past the base case.' }]);
  assert.deepEqual(run.addedGoals, ['weaker_theorem']);

  await f.core.resume();
  assert.deepEqual(await f.core.agentGoals(), ['weaker_theorem'], 'the agent\'s goals stay marked after the run');

  const nodes = [...f.map.keys()].filter((file) => /^research\/assets\/.*\.md$/.test(file)).map((file) => {
    const { data, content } = matter(f.map.get(file));
    return { id: path.posix.basename(file, '.md'), filePath: file, body: content, tags: [], depends_on: [], uses_definitions: [], related_assets: [], ...data };
  });
  const payload = buildGraphPayload({ nodes, project: weaker, projectApproved: true, state: f.core.current, manuscript: undefined, sectionsDir: 'sections', now: 'now' });
  const main = payload.nodes.find((node) => node.id === 'main_theorem');
  assert.deepEqual([main.progressLabel, main.progressDetail], ['Set aside by the agent', 'No route past the base case.']);
});

test('autonomous mode checks a library result against its source before using it as known', async () => {
  const f = fixture({ maxFailedPlans: 3 });
  const LIB = 'research/library/thesis/assets';
  f.map.set(`${LIB}/lib_known.md`, matter.stringify('\n## Statement\n\nEvery n satisfies P(n).\n', { type: 'lemma', title: 'Known lemma', status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [] }));
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', asset('main_theorem', { depends_on: ['lib_known'] }));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  const next = await f.core.next();
  assert.equal(next.stage, 'verify_node');
  assert.deepEqual(f.core.current.current.node, { id: 'lib_known', mode: 'citation' });
  assert.match(next.instruction, /every hypothesis kept/);
  assert.equal(matter(f.map.get(`${LIB}/lib_known.md`)).data.status, 'draft', 'not used as known before the check');
  await f.core.report({ outcome: 'confirmed', summary: 'Matches Theorem 2.1 of the thesis.' });
  assert.equal(matter(f.map.get(`${LIB}/lib_known.md`)).data.status, 'approved');
  assert.equal(f.core.current.autonomy.spent, 0, 'a check spends no attempt');
  assert.equal((await f.core.next()).stage, 'plan');

  // At hand-back, what only an agent checked is listed for the researcher.
  assert.deepEqual((await f.core.autonomySummary()).agentChecked, { definitions: [], citations: ['lib_known'], rechecked: [] });
  await f.core.report({ outcome: 'none', summary: 'No approach in sight.' });
  await f.core.park('main_theorem', 'agent_gave_up', 'Nothing in sight.');
  f.map.set(SETTINGS, JSON.stringify({ version: 1, rigor: { refuteSearch: 'off', verifyProofs: 'off' }, autonomy: { enabled: true }, autonomyRevisions: 0 }));
  const handed = await f.core.next();
  assert.match(handed.instruction, /approved on an independent agent's check alone/);
  const handoff = [...f.map.entries()].find(([file]) => file.startsWith('research/handoffs/'))[1];
  assert.match(handoff, /Approved on an independent agent's check alone; worth your review:\n- Results taken from a source \(checked against it\): lib_known/);
});
