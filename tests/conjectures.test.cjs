const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const { decisionDocs, decisionData, handoffTexts, ideaRaw, logRecords } = require('./records-fixtures.cjs');
const { searchNothing } = require('./search-fixtures.cjs');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { rankConjectures } = load('../src/domain/conjectures.ts');
const { nodeProblems, stripForeignFields } = load('../src/domain/schema.ts');
const { DEFAULT_LOOP_SETTINGS } = load('../src/domain/loopSettings.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const projectWith = (required) => `---\ntype: project\nschema_version: 2\nrequired_results:\n${required.map((id) => `  - id: ${id}\n    role: a goal\n`).join('')}---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n`;
const project = projectWith(['main_theorem']);
const asset = (id, extra = {}) => matter.stringify(`\n## Statement\n\nFor every natural number n, ${id} holds.\n`, { type: 'theorem', title: id, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const conjecture = (id, extra = {}) => matter.stringify(`\n## Statement\n\nFor every natural number n, n + 0 = n.\n\n## Motivation\n\nTrue for small n; it would give the main theorem a second proof.\n`, { type: 'conjecture', title: id, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], serves: ['main_theorem'], tags: [], ...extra });
const plan = (id, target, status) => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\nProve it.\n\n## Plan\n\n1. [ ] Apply reflexivity.\n\n## Verification\n\nCheck it.\n${status === 'succeeded' ? '\n## Outcome\n\nProved.\n' : ''}`, { type: 'plan', title: id, status, target_asset: target, inspired_by: [], tags: [] });
const SETTINGS = '.research-assistant-loop/settings.json';

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
function fixture(settings) {
  const files = memoryFiles({ 'research/project.md': '# Project\n', 'research/papers.md': '# Papers\n', [SETTINGS]: JSON.stringify({ version: 1, routeWidth: 0, ...settings }) });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}` });
  return { files, core, map: files.map };
}
const data = (f, file) => matter(file.startsWith('research/ideas/') ? ideaRaw(f.map, file.slice('research/ideas/'.length, -3)) : f.map.get(file)).data;
const routine = (rules = {}, rigor = {}) => ({ autoApprove: { enabled: true, ...rules }, rigor: { verifyProofs: 'off', refuteSearch: 'all', ...rigor } });

/** Goals approved, main_theorem scaffolded, searched when the setting asks, then planned and proved. */
async function proveMain(f) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  if (request) await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', asset('main_theorem'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  if ((await f.core.next()).stage === 'search') await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');
  f.map.set('research/plans/attempt_1.md', plan('attempt_1', 'main_theorem', 'pending'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  f.map.set('research/assets/main_theorem.md', asset('main_theorem') + '\n## Proof\n\nEquality is reflexive.\n');
  f.map.set('research/plans/attempt_1.md', plan('attempt_1', 'main_theorem', 'succeeded'));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
}

test('conjectures rank by how they relate to the goals, then by the researcher', () => {
  const context = { open: new Set(['main_theorem', 'stuck_lemma']), proved: new Set(['known_bound']) };
  const ranked = rankConjectures([
    { id: 'independent', status: 'approved', serves: [] },
    { id: 'strengthens', status: 'draft', serves: ['known_bound'], falsified: true },
    { id: 'unblocks', status: 'draft', serves: ['stuck_lemma'] },
    { id: 'theirs', status: 'draft', serves: ['main_theorem'], researcher: true },
    { id: 'low', status: 'approved', serves: ['main_theorem'], priority: 'low' },
    { id: 'refuted', status: 'draft', serves: ['main_theorem'], refuted: true },
    { id: 'retired', status: 'deprecated', serves: ['main_theorem'] },
  ], context);
  assert.deepEqual(ranked.map((item) => item.id), ['theirs', 'unblocks', 'low', 'strengthens', 'independent']);
  assert.deepEqual(ranked.map((item) => item.rank), [0, 0, 0, 1, 2]);
  assert.match(ranked[0].reason, /serves an open goal \(main_theorem\); raised by the researcher/);
});

test('a conjecture states its motivation, has no proof, and alone may carry serves and priority', () => {
  const body = '\nFor every n, n + 0 = n.\n\n## Motivation\n\nSmall cases.\n';
  assert.deepEqual(nodeProblems('asset', 'c', { type: 'conjecture', title: 'C', status: 'draft', serves: ['main_theorem'], priority: 'high' }, body), []);
  assert.match(nodeProblems('asset', 'c', { type: 'conjecture', title: 'C', status: 'draft' }, '\nFor every n.\n').join('\n'), /needs ## Motivation/);
  assert.match(nodeProblems('asset', 'c', { type: 'conjecture', title: 'C', status: 'draft' }, `${body}\n## Proof\n\nTrivial.\n`).join('\n'), /no ## Proof/);
  assert.match(nodeProblems('asset', 'c', { type: 'conjecture', title: 'C', status: 'draft', priority: 'urgent' }, body).join('\n'), /priority must be high or low/);
  assert.match(nodeProblems('asset', 'l', { type: 'lemma', title: 'L', status: 'draft', serves: ['x'] }, body).join('\n'), /belong to conjectures only/);
  assert.deepEqual(Object.keys(stripForeignFields('asset', { serves: ['x'], depends_on: [] }, 'lemma')), ['depends_on']);
  assert.deepEqual(Object.keys(stripForeignFields('asset', { serves: ['x'] }, 'conjecture')), ['serves']);
  assert.deepEqual([DEFAULT_LOOP_SETTINGS.autoApprove.conjectures, DEFAULT_LOOP_SETTINGS.autoApprove.conjectureIdeas, DEFAULT_LOOP_SETTINGS.autonomyConjectures], [true, true, 0]);
});

test('in auto mode, once the goals are done, a conjecture idea is made precise, searched, agreed, and recommended', async () => {
  const f = fixture(routine());
  const ideaId = await f.core.saveIdea('Adding zero', 'n + 0 = n should hold for every n; it would give another proof.', [], 'researcher', [], 'conjecture');
  await proveMain(f);
  assert.equal(data(f, 'research/assets/main_theorem.md').status, 'approved', 'the proof was approved automatically');

  const made = await f.core.next();
  assert.equal(made.stage, 'conjecture');
  assert.equal(f.core.current.current.ideaId, ideaId);
  assert.match(made.instruction, /Make it precise as one new conjecture/);
  // Only a conjecture may be written in this stage.
  f.map.set('research/assets/add_zero.md', asset('add_zero'));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Stated', assetId: 'add_zero' }), /writes one conjecture/);
  f.map.set('research/assets/add_zero.md', conjecture('add_zero', { serves: ['nowhere'] }));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Stated', assetId: 'add_zero' }), /serves unknown result nowhere/);
  f.map.set('research/assets/add_zero.md', conjecture('add_zero'));
  await f.core.report({ outcome: 'complete', summary: 'Stated', assetId: 'add_zero' });
  assert.deepEqual([data(f, `research/ideas/${ideaId}.md`).status, data(f, `research/ideas/${ideaId}.md`).resolved_by], ['resolved', 'add_zero']);

  // Searched for a counterexample, never planned.
  const searching = await f.core.next();
  assert.deepEqual([searching.stage, f.core.current.current.assetId], ['search', 'add_zero']);
  const searched = await searchNothing(f, 'add_zero');
  assert.equal(searched.stage, 'select');
  assert.match(searched.message, /goes to the researcher to agree on/);

  // Agreed automatically by the conjectures rule, then the project is ready and the conjecture recommended.
  const ready = await f.core.next();
  assert.equal(ready.stage, 'ready');
  assert.equal(data(f, 'research/assets/add_zero.md').status, 'approved');
  assert.equal(data(f, 'research/assets/add_zero.md').type, 'conjecture');
  assert.match(ready.instruction, /Conjectures worth taking up next, best first:\n- add_zero: strengthens a proved result \(main_theorem\); raised by the researcher; statement agreed/);
  assert.equal(f.core.current.approvalQueue.length, 0);
});

test('without permission the agent leaves conjecture ideas alone, unless the researcher asks for one', async () => {
  const f = fixture(routine({ conjectureIdeas: false }));
  const ideaId = await f.core.saveIdea('Adding zero', 'n + 0 = n.', [], 'researcher', [], 'conjecture');
  await proveMain(f);
  assert.equal((await f.core.next()).stage, 'ready');
  assert.equal(data(f, `research/ideas/${ideaId}.md`).status, 'draft');

  await f.core.requestConjecture(ideaId);
  assert.equal((await f.core.next()).stage, 'conjecture');
  await f.core.report({ outcome: 'none', summary: 'It is the definition of addition; nothing to conjecture.' });
  assert.equal(data(f, `research/ideas/${ideaId}.md`).status, 'draft', 'the idea stays for the researcher');
  assert.match(ideaRaw(f.map, ideaId), /## Not yet a conjecture\n\nIt is the definition of addition/);
  assert.equal((await f.core.next()).stage, 'ready', 'an idea is tried once');
  await assert.rejects(f.core.requestConjecture('main_theorem'), /not a conjecture/);
});

test('a conjecture becomes a goal only by promotion while the goals are drafted, keeping its search', async () => {
  const f = fixture(routine());
  await proveMain(f);
  f.map.set('research/assets/add_zero.md', conjecture('add_zero'));
  assert.equal((await f.core.next()).stage, 'search');
  await searchNothing(f, 'add_zero');
  assert.equal((await f.core.next()).stage, 'ready');

  await assert.rejects(f.core.promoteConjecture('add_zero', 'lemma'), /while the goals are drafted/);
  await f.core.extend('Take up the conjecture add_zero');
  assert.equal((await f.core.next()).stage, 'draft_project');
  f.map.set(paths.projectMd, projectWith(['main_theorem', 'add_zero']));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Added it' }), /rest on the conjecture\(s\) add_zero/);
  await assert.rejects(f.core.promoteConjecture('add_zero', 'corollary'), /--as must be one of/);
  assert.match(await f.core.promoteConjecture('add_zero', 'lemma'), /now a draft lemma/);
  const promoted = data(f, 'research/assets/add_zero.md');
  assert.deepEqual([promoted.type, promoted.status, promoted.serves], ['lemma', 'draft', undefined]);
  await f.core.report({ outcome: 'complete', summary: 'Added it' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  // The search carried over to the lemma: the loop plans at once.
  const next = await f.core.next();
  assert.deepEqual([next.stage, f.core.current.current.assetId], ['plan', 'add_zero']);
});

test('a draft result no goal needs any more becomes a conjecture, its park lifted and pending plans abandoned', async () => {
  const f = fixture(routine());
  await proveMain(f);
  f.map.set('research/assets/old_route.md', asset('old_route', { type: 'lemma' }));
  f.map.set('research/plans/old_attempt.md', plan('old_attempt', 'old_route', 'pending'));
  await f.core.park('old_route', 'three_failures', 'No bound at n = 0.');
  await assert.rejects(f.core.demoteToConjecture('main_theorem', 'Still believed.'), /approved; only a draft result/);
  await assert.rejects(f.core.demoteToConjecture('old_route', ''), /--note/);
  assert.match(await f.core.demoteToConjecture('old_route', 'Still believed for n >= 1; it would give a sharper constant.', ['main_theorem']), /now a conjecture; its pending plan\(s\) old_attempt were abandoned/);
  const demoted = matter(f.map.get('research/assets/old_route.md'));
  assert.deepEqual([demoted.data.type, demoted.data.serves], ['conjecture', ['main_theorem']]);
  assert.match(demoted.content, /## Motivation\n\nStill believed for n >= 1/);
  assert.equal(data(f, 'research/plans/old_attempt.md').status, 'abandoned');
  assert.equal(f.core.current.parked.old_route, undefined);
  assert.deepEqual(await f.core.validateAll(), []);

  // A required result cannot be demoted.
  f.map.set(paths.projectMd, projectWith(['main_theorem', 'goal_lemma']));
  f.map.set('research/assets/goal_lemma.md', asset('goal_lemma', { type: 'lemma' }));
  await assert.rejects(f.core.demoteToConjecture('goal_lemma', 'Believed.'), /still on the way to the goals \(it is a required result\)/);
});

test('working on its own with permission, the agent takes up the best conjecture once the goals are proved', async () => {
  const f = fixture({ autonomy: { enabled: true }, autonomyConjectures: 1, rigor: { verifyProofs: 'off', refuteSearch: 'off' } });
  await proveMain(f);
  f.map.set('research/assets/add_zero.md', conjecture('add_zero'));
  f.map.set('research/assets/independent.md', conjecture('independent', { serves: [] }));

  const exploring = await f.core.next();
  assert.equal(exploring.stage, 'draft_project');
  assert.equal(f.core.current.researcherInput.kind, 'autonomous_conjecture');
  assert.match(exploring.instruction, /Autonomous exploration 1 of 1[\s\S]*- add_zero: strengthens a proved result[\s\S]*- independent: of independent interest/);
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Thought about it' }), /take up a conjecture/);
  await f.core.promoteConjecture('add_zero', 'lemma');
  f.map.set(paths.projectMd, projectWith(['main_theorem', 'add_zero']));
  const added = await f.core.report({ outcome: 'complete', summary: 'Took up add_zero' });
  assert.match(added.message, /approved automatically/);
  assert.deepEqual(await f.core.agentGoals(), ['add_zero']);
  assert.equal((await f.core.next()).stage, 'plan');
});

test('working on its own, a reassessment offers conjectures that serve a set-aside goal, and the run hands back recommending them', async () => {
  const f = fixture({ autonomy: { enabled: true }, autonomyRevisions: 1, maxFailedPlans: 1, rigor: { verifyProofs: 'off', refuteSearch: 'off' } });
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', asset('main_theorem'));
  f.map.set('research/assets/add_zero.md', conjecture('add_zero'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'plan');
  await f.core.park('main_theorem', 'agent_gave_up', 'No route past n = 0.');

  const reassess = await f.core.next();
  assert.equal(reassess.stage, 'draft_project');
  assert.match(reassess.instruction, /\(c\) Take up a conjecture that serves an open goal[\s\S]*- add_zero: serves an open goal \(main_theorem\)/);
  await f.core.report({ outcome: 'none', summary: 'Nothing sound.' });
  const handed = await f.core.report({ outcome: 'none', summary: 'main_theorem: no route.', confirm: true });
  assert.match(handed.message, /recommend the conjectures worth taking up next \(add_zero/);
  const handoff = handoffTexts(f.map).join('\n');
  assert.match(handoff, /Conjectures worth taking up next, best first:\n- add_zero/);
});

test('making a conjecture precise gets a pack with the idea, what it relates to, the goals, and the conjectures already stated', async () => {
  const f = fixture(routine());
  await proveMain(f);
  f.map.set('research/assets/add_zero.md', conjecture('add_zero', { status: 'deprecated' }));
  f.map.set('research/assets/mult_one.md', conjecture('mult_one'));
  await f.core.requestConjecture('mult_one');
  const ideaId = await f.core.saveIdea('Doubling', 'n + n = 2n for every n.', ['main_theorem'], 'agent', [], 'conjecture');
  assert.equal((await f.core.next()).stage, 'search', 'a conjecture to search comes before an idea to make precise');
  await searchNothing(f, 'mult_one');
  const made = await f.core.next();
  assert.equal(made.stage, 'conjecture');
  assert.equal(made.brief.worker, 'deep');
  const pack = await f.core.contextPack();
  const ids = pack.manifest.items.map((item) => item.id);
  for (const id of [ideaId, 'main_theorem', 'project', 'mult_one', 'index']) assert.ok(ids.includes(id), `pack has ${id}`);
  assert.ok(!ids.includes('add_zero'), 'a retired conjecture is left out');
});
