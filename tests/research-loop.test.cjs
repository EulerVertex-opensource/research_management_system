const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const matter = require('gray-matter');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { researchDigest, statementDigest, validateResearchFile, safeRelativeFile } = load('../src/services/ResearchLoopModel.ts');
const { requiredAssetIds, requiredResults } = load('../src/domain/project.ts');
const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const legacyProject = '# Project\n\n## Main Problem\n\nProve A.\n\n## Current Goals\n\nFind a proof.\n\n## Required Results\n\n- main_theorem: the central claim\n\n## Known Results\n\nNone.\n';
const asset = (proof = '', extra = {}) => matter.stringify(`\n## Statement\n\nFor every natural number n, n = n.\n${proof}`, { type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const plan = (id, status = 'pending', difference = '') => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\nProve reflexivity.\n\n## Plan\n\n1. [ ] Apply equality reflexivity.\n\n## Verification\n\nCheck the equality.\n${difference}${status === 'failed' ? '\n## Failure\n\nThis approach cannot establish the needed equality.\n' : ''}`, { type: 'plan', title: id, status, target_asset: 'main_theorem', inspired_by: [], tags: [] });
const check = (target = 'main_theorem') => matter.stringify('\n## Cases checked\n\n- n = 0 and n = 1\n\n## Limitations\n\nOnly small cases.\n', { type: 'falsification_check', title: `Check ${target}`, target_asset: target, outcome: 'no_counterexample_found' });
const succeeded = (id) => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\n## Plan\n\n1. [x] Apply reflexivity.\n\n## Verification\n\nCheck the equality.\n\n## Outcome\n\nProof incorporated into main_theorem.\n`, { type: 'plan', title: id, status: 'succeeded', target_asset: 'main_theorem', inspired_by: [], tags: [] });

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
function fixture(initial = {}) {
  const files = memoryFiles({ 'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n', ...initial });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map };
}

async function driveToPlan(f) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  assert.equal(f.core.current.stage, 'draft_project');
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  assert.equal(f.core.current.stage, 'review_project');
  assert.equal(f.map.has('research/approvals.json'), false);
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', asset());
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  assert.equal(f.core.current.stage, 'sources');
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'falsify');
  assert.equal(f.core.current.current.assetId, 'main_theorem');
  await assert.rejects(f.core.report({ outcome: 'none', summary: 'No counterexample' }), /falsification check/);
  f.map.set('research/checks/check_main_theorem_small.md', check());
  await f.core.report({ outcome: 'none', summary: 'No counterexample' });
  assert.match(f.map.get('research/checks/check_main_theorem_small.md'), /statement_digest: /);
  assert.equal(f.core.current.stage, 'plan');
}

async function driveToReady(f) {
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  f.map.set('research/assets/main_theorem.md', asset(`\n## Proof\n\nEquality is reflexive (run ${++counter}).\n`));
  f.map.set('research/plans/attempt_1.md', succeeded('attempt_1'));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
  const approval = f.core.current.approvalQueue.find((item) => item.kind === 'asset' && item.target === 'main_theorem');
  await f.core.resolveApproval(approval.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'ready');
}

const extendedProject = project.replace('    role: the central claim\n', '    role: the central claim\n  - id: second_theorem\n    role: the new conjecture\n');

test('required results, digests, and validators', () => {
  assert.deepEqual(requiredResults(project), [{ id: 'main_theorem', role: 'the central claim' }]);
  // Projects not yet migrated still read their required results from the legacy section.
  assert.deepEqual(requiredResults(legacyProject), [{ id: 'main_theorem', role: 'the central claim' }]);
  assert.deepEqual(requiredAssetIds('# Project\n\n## Required Results\n\n- `lemma_a` supporting lemma\n- [x] main_theorem\n'), ['lemma_a', 'main_theorem']);
  assert.equal(researchDigest(project, 'project'), researchDigest(project.replace('None.', 'Some background.'), 'project'));
  assert.notEqual(researchDigest(project, 'project'), researchDigest(project.replace('Natural numbers.', 'Integers.'), 'project'));
  assert.notEqual(researchDigest(project, 'project'), researchDigest(extendedProject, 'project'));
  assert.equal(researchDigest(legacyProject, 'project'), researchDigest(legacyProject + '\n## Writing Status\n\nlater\n', 'project'));
  assert.notEqual(researchDigest(asset(), 'asset'), researchDigest(asset('\n## Proof\n\nNew proof.\n'), 'asset'));
  assert.equal(statementDigest(asset()), statementDigest(asset('\n## Proof\n\nNew proof.\n')));
  const withLink = asset().replace('natural number', '[natural number](../definitions/natural.md)');
  assert.equal(researchDigest(asset(), 'asset'), researchDigest(withLink, 'asset'));
  assert.throws(() => safeRelativeFile('../escape.md'));
  assert.throws(() => validateResearchFile('research/assets/fake.md', matter.stringify('\n## Statement\n\nFake.\n', { type: 'theorem', title: 'Fake', status: 'approved' }), paths, new Set()), /approval is a researcher action/);
});

test('happy path: goals, approval gates, proof record, ready, and invalidation on edit', async () => {
  const f = fixture();
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  assert.equal(f.core.current.stage, 'execute');
  f.map.set('research/assets/main_theorem.md', asset('\n## Proof\n\nEquality is reflexive.\n'));
  f.map.set('research/plans/attempt_1.md', succeeded('attempt_1'));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'draft');
  const approval = f.core.current.approvalQueue.find((item) => item.kind === 'asset' && item.target === 'main_theorem');
  assert.ok(approval);
  assert.equal((await f.core.next()).stage, 'waiting');
  await f.core.resolveApproval(approval.id, 'approved', '', 'test');
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'approved');
  assert.equal((await f.core.next()).stage, 'ready');
  f.map.set('research/assets/main_theorem.md', f.map.get('research/assets/main_theorem.md').replace('Equality is reflexive.', 'Modified proof.'));
  assert.deepEqual(await f.core.reconcile('main_theorem'), ['main_theorem']);
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'draft');
  assert.equal((await f.core.next()).stage, 'waiting');
});

test('approving does not leak into later parses of the same draft text', async () => {
  const draft = asset('\n## Proof\n\nShared text.\n');
  const f = fixture({ 'research/assets/main_theorem.md': draft, 'research/assets/copy.md': draft });
  await f.core.start('claude');
  await f.core.approve('asset', 'main_theorem', 'test');
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'approved');
  const { parseMarkdown } = load('../src/services/Frontmatter.ts');
  assert.equal(parseMarkdown(draft).data.status, 'draft');
  const result = await f.core.validateWorkspace({ fix: true });
  assert.deepEqual(result.problems, []);
  assert.equal(parseMarkdown(f.map.get('research/assets/copy.md')).data.status, 'draft');
});

test('ready offers extend; an extension adds a goal and keeps approved results', async () => {
  const f = fixture();
  await driveToReady(f);
  assert.match((await f.core.next()).instruction, /research-loop\.cjs extend/);
  await f.core.extend('Also prove the second theorem.');
  assert.equal(f.core.current.stage, 'draft_project');
  const drafting = await f.core.next();
  assert.equal(drafting.stage, 'draft_project');
  assert.match(drafting.instruction, /keep every existing required_results entry \(main_theorem\)/);
  assert.match(drafting.instruction, /Also prove the second theorem/);
  await assert.rejects(() => f.core.report({ outcome: 'complete', summary: 'No change' }), /add the new goal as a new asset ID/);
  f.map.set(paths.projectMd, extendedProject.replace('  - id: main_theorem\n    role: the central claim\n', ''));
  await assert.rejects(() => f.core.report({ outcome: 'complete', summary: 'Replaced' }), /keep the existing required results main_theorem/);
  f.map.set(paths.projectMd, extendedProject);
  await f.core.report({ outcome: 'complete', summary: 'Added second_theorem' });
  assert.equal(f.core.current.stage, 'review_project');
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  assert.deepEqual(f.core.current.scaffoldBrief.missing, ['second_theorem']);
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'approved');
  f.map.set('research/assets/second_theorem.md', asset('', { title: 'Second theorem' }));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'falsify');
  assert.equal(f.core.current.current.assetId, 'second_theorem');
  f.map.set('research/assets/second_theorem.md', asset('\n## Proof\n\nSecond proof by reflexivity.\n', { title: 'Second theorem' }));
  await f.core.approve('asset', 'second_theorem', 'test');
  const ready = await f.core.next();
  assert.equal(ready.stage, 'ready');
  assert.deepEqual(f.core.current.extension.newResults, ['second_theorem']);
  assert.match(ready.instruction, /new result\(s\) second_theorem.*plan-manuscript/);
});

test('starting with a goal on an approved project extends it instead of returning to ready', async () => {
  const f = fixture();
  await driveToReady(f);
  await f.core.start('claude', { goal: 'Add a new conjecture.', force: true });
  assert.equal(f.core.current.stage, 'draft_project');
  assert.deepEqual(f.core.current.extension.baselineRequired, ['main_theorem']);
  assert.equal((await f.core.next()).stage, 'draft_project');
});

test('a goal given while the loop runs extends it, and an unapproved draft takes the goal before review', async () => {
  const f = fixture();
  await driveToReady(f);
  assert.match(f.core.briefStatus(), /extend --goal/);
  await f.core.start('claude', { goal: 'Add a new conjecture.' });
  assert.equal(f.core.current.stage, 'draft_project');
  assert.deepEqual(f.core.current.extension.baselineRequired, ['main_theorem']);

  const g = fixture({ 'research/project.md': project });
  await g.core.extend('Also prove B.');
  assert.equal(g.core.current.stage, 'draft_project');
  assert.match((await g.core.next()).instruction, /Also prove B/);
  await g.core.report({ outcome: 'complete', summary: 'Drafted' });
  assert.equal(g.core.current.stage, 'review_project');
});

test('ready reports the manuscript as a second status beside the research', async () => {
  const f = fixture();
  await driveToReady(f);
  assert.doesNotMatch((await f.core.next()).instruction, /Manuscript:/);
  f.map.set('research/writing/outline.md', '# Outline\n\n## Sections\n\n1. [Main result](sections/main_result.md)\n');
  f.map.set('research/writing/sections/main_result.md', '---\ntitle: Main result\nassets: []\n---\n');
  const ready = await f.core.next();
  assert.equal(ready.stage, 'ready');
  assert.match(ready.instruction, /Manuscript: uncovered \(project revision 1\)/);
  assert.match(ready.instruction, /Uncovered required results: main_theorem\n- main_result: unlocked/);
  assert.match(ready.instruction, /manuscript-writing\.cjs lock <section> --apply/);
});

test('execution may not change the statement, and failed plans need a difference section', async () => {
  const f = fixture();
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  f.map.set('research/assets/main_theorem.md', asset('\n## Proof\n\nDone.\n').replace('n = n', 'n = n + 0'));
  f.map.set('research/plans/attempt_1.md', succeeded('attempt_1'));
  await assert.rejects(() => f.core.report({ outcome: 'proved', summary: 'Proved' }), /statement changed/);
  f.map.set('research/assets/main_theorem.md', asset());
  f.map.set('research/plans/attempt_1.md', plan('attempt_1', 'failed'));
  await f.core.report({ outcome: 'failed', summary: 'Obstructed' });
  assert.equal(f.core.current.stage, 'plan');
  f.map.set('research/plans/attempt_2.md', plan('attempt_2'));
  await assert.rejects(() => f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_2' }), /Difference from failed plans/);
  f.map.set('research/plans/attempt_2.md', plan('attempt_2', 'pending', '\n## Difference from failed plans\n\n- attempt_1: use induction instead\n'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_2' });
  assert.equal(f.core.current.stage, 'execute');
});

test('a plan stage writes one plan, and a proof marks it succeeded rather than a legacy proof record', async () => {
  const f = fixture();
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  f.map.set('research/plans/attempt_2.md', plan('attempt_2'));
  await assert.rejects(() => f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' }), /Write one plan per plan stage; found 2 new plans/);
  f.map.delete('research/plans/attempt_2.md');
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  f.map.set('research/assets/main_theorem.md', asset('\n## Proof\n\nEquality is reflexive.\n'));
  f.map.set('research/plans/attempt_1.md', succeeded('attempt_1').replace('type: plan', 'type: proof_record').replace('status: succeeded\n', ''));
  await assert.rejects(() => f.core.report({ outcome: 'proved', summary: 'Proved' }), /proof_record is a legacy type/);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  await assert.rejects(() => f.core.report({ outcome: 'proved', summary: 'Proved' }), /must get status succeeded and a ## Outcome/);
  f.map.set('research/plans/attempt_1.md', succeeded('attempt_1'));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
  assert.equal(f.core.current.stage, 'select');
});

test('whole-workspace validation reports a node ID used in two research folders', async () => {
  const f = fixture({ 'research/assets/main_theorem.md': asset(), 'research/ideas/main_theorem.md': matter.stringify('\nSame ID.\n', { type: 'idea', title: 'Clash', status: 'draft' }) });
  await f.core.start('claude');
  assert.ok((await f.core.validateAll()).some((problem) => /research\/ideas\/main_theorem\.md: node ID main_theorem is already used by research\/assets\/main_theorem\.md/.test(problem)));
});

test('three failed approaches ask the researcher; silence parks the asset', async () => {
  const f = fixture();
  await driveToPlan(f);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const difference = attempt > 1 ? `\n## Difference from failed plans\n\n${Array.from({ length: attempt - 1 }, (_, i) => `- attempt_${i + 1}: different route`).join('\n')}\n` : '';
    f.map.set(`research/plans/attempt_${attempt}.md`, plan(`attempt_${attempt}`, 'pending', difference));
    await f.core.report({ outcome: 'complete', summary: 'Planned', planId: `attempt_${attempt}` });
    f.map.set(`research/plans/attempt_${attempt}.md`, plan(`attempt_${attempt}`, 'failed', difference));
    await f.core.report({ outcome: 'failed', summary: 'Obstructed' });
  }
  assert.equal(f.core.current.pendingQuestion.kind, 'blocked');
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'draft');
  await f.core.autoResolveQuestion(f.core.current.pendingQuestion.id);
  assert.equal(f.core.current.parked.main_theorem.reason, 'three_failures');
  assert.equal((await f.core.next()).stage, 'waiting');
  await f.core.unpark('main_theorem');
  assert.equal((await f.core.next()).stage, 'plan');
});

test('confirmed counterexample deprecates the asset and returns to the project goals', async () => {
  const f = fixture();
  await f.core.start('claude', { goal: 'Investigate.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.resolveApproval(f.core.current.approvalQueue[0].id, 'approved', '', 'test');
  await f.core.next();
  f.map.set('research/assets/main_theorem.md', asset());
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'falsify');
  f.map.set('research/assets/counterexample_1.md', matter.stringify('\n## Assumptions\n\nAll hypotheses hold.\n\n## Calculation\n\nThe conclusion fails.\n', { type: 'example', title: 'Counterexample', status: 'draft', refutes: 'main_theorem', depends_on: [], uses_definitions: [] }));
  await f.core.report({ outcome: 'candidate', summary: 'Found', counterexampleId: 'counterexample_1' });
  assert.equal(f.core.current.stage, 'verify_counterexample');
  f.map.set('research/assets/counterexample_1.md', f.map.get('research/assets/counterexample_1.md') + '\n## Verdict\n\nconfirmed\n');
  await f.core.report({ outcome: 'confirmed', summary: 'Checked' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'counterexample');
  assert.equal(request.target, 'counterexample_1');
  assert.equal((await f.core.next()).stage, 'waiting');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'deprecated');
  assert.equal(matter(f.map.get('research/assets/counterexample_1.md')).data.status, 'approved');
  assert.equal((await f.core.next()).stage, 'draft_project');
});

test('a confirmed counterexample abandons the refuted asset\'s pending plans', async () => {
  const f = fixture();
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  f.map.set('research/assets/counterexample_1.md', matter.stringify('\n## Assumptions\n\nAll hypotheses hold.\n\n## Calculation\n\nThe conclusion fails.\n\n## Verdict\n\nconfirmed\n', { type: 'example', title: 'Counterexample', status: 'draft', refutes: 'main_theorem' }));
  await f.core.confirmCounterexample('counterexample_1', 'test');
  const abandoned = matter(f.map.get('research/plans/attempt_1.md'));
  assert.equal(abandoned.data.status, 'abandoned');
  assert.match(abandoned.content, /## Outcome\n\nTarget main_theorem was refuted by counterexample counterexample_1/);
});

test('a proof stamps proof_digest on its plan, and show marks the plan outdated after the proof changes', async () => {
  const f = fixture();
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  f.map.set('research/assets/main_theorem.md', asset('\n## Proof\n\nEquality is reflexive.\n'));
  f.map.set('research/plans/attempt_1.md', succeeded('attempt_1'));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
  assert.match(matter(f.map.get('research/plans/attempt_1.md')).data.proof_digest, /^[0-9a-f]{64}$/);
  assert.match(await f.core.show('main_theorem'), /- Plans: attempt_1 \(succeeded\)/);
  f.map.set('research/assets/main_theorem.md', asset('\n## Proof\n\nA different argument.\n'));
  assert.match(await f.core.show('main_theorem'), /attempt_1 \(succeeded, outdated: the proof changed since\)/);
  assert.doesNotMatch(f.map.get('research/assets/main_theorem.md'), /attempt_1/);
});

test('a researcher direction is a decision, not also an idea', async () => {
  const f = fixture();
  await driveToPlan(f);
  const question = await f.core.askQuestion('blocked', 'Three plans failed.', { assetId: 'main_theorem' });
  const ideasBefore = [...f.map.keys()].filter((file) => file.startsWith('research/ideas/')).length;
  await f.core.answerQuestion(question.id, 'answer', 'Try induction on n.', 'test');
  assert.equal([...f.map.keys()].filter((file) => file.startsWith('research/ideas/')).length, ideasBefore);
  assert.ok([...f.map.entries()].some(([file, raw]) => file.startsWith('research/decisions/') && /kind: direction/.test(raw) && /Try induction on n\./.test(raw)));
  assert.equal(f.core.current.stage, 'plan');
});

test('an unanswered question becomes a question idea that a late answer resolves', async () => {
  const f = fixture({ 'research/assets/main_theorem.md': asset() });
  await f.core.start('claude');
  const question = await f.core.askQuestion('discussion', 'Is compactness needed?', { assetId: 'main_theorem' });
  await f.core.autoResolveQuestion(question.id);
  const [ideaFile] = [...f.map.keys()].filter((file) => file.startsWith('research/ideas/'));
  assert.deepEqual([matter(f.map.get(ideaFile)).data.idea_kind, matter(f.map.get(ideaFile)).data.status], ['question', 'draft']);
  await f.core.answerQuestion(question.id, 'answer', 'Yes, for the limit argument.', 'test');
  const resolved = matter(f.map.get(ideaFile));
  assert.equal(resolved.data.status, 'resolved');
  assert.match(resolved.data.resolved_by, /^decision_/);
  assert.ok(f.map.has(`research/decisions/${resolved.data.resolved_by}.md`));
  assert.match(resolved.content, /## Resolution\n\nAnswered by the researcher: Yes, for the limit argument\./);
});

test('textbook results are cited, not falsified or proved', async () => {
  const f = fixture({ 'research/papers.md': '# Papers\n\n## rudin\n\nhttps://example.org/rudin\n' });
  await f.core.start('claude', { goal: 'Use a textbook result.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.resolveApproval(f.core.current.approvalQueue[0].id, 'approved', '', 'test');
  await f.core.next();
  f.map.set('research/assets/main_theorem.md', asset('', { source: { kind: 'textbook', paper_id: 'rudin', location: 'Theorem 7.9' } }));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'waiting');
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'citation' && item.target === 'main_theorem'));
});

test('renaming source.kind self_proved to original keeps approvals valid', () => {
  const legacy = asset().replace('kind: self_proved', 'kind: self_proved');
  const renamed = asset('', { source: { kind: 'original' } });
  assert.match(legacy, /kind: self_proved/);
  assert.equal(researchDigest(legacy, 'asset'), researchDigest(renamed, 'asset'));
  assert.equal(statementDigest(legacy), statementDigest(renamed));
  assert.notEqual(researchDigest(legacy, 'asset'), researchDigest(asset('', { source: { kind: 'note' } }), 'asset'));
});

test('agent-set approvals are reverted and dependency statement changes invalidate dependants', async () => {
  const f = fixture({ 'research/assets/main_theorem.md': asset('', { status: 'approved', depends_on: ['key_lemma'] }), 'research/assets/key_lemma.md': matter.stringify('\n## Statement\n\nA lemma.\n', { type: 'lemma', title: 'Key lemma', status: 'approved', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [] }) });
  await f.core.start('codex');
  const adopted = [...f.map.keys()].filter((file) => file.startsWith('research/approvals/assets/')).map((file) => JSON.parse(f.map.get(file)).target).sort();
  assert.deepEqual(adopted, ['key_lemma', 'main_theorem']);
  f.map.set('research/assets/forged.md', asset('', { status: 'approved' }));
  const result = await f.core.validateWorkspace({ fix: true });
  assert.deepEqual(result.fixed, ['forged']);
  assert.equal(matter(f.map.get('research/assets/forged.md')).data.status, 'draft');
  f.map.set('research/assets/key_lemma.md', f.map.get('research/assets/key_lemma.md').replace('A lemma.', 'A stronger lemma.'));
  const reverted = await f.core.reconcile('key_lemma');
  assert.deepEqual(reverted.sort(), ['key_lemma', 'main_theorem']);
});

test('ideas remain after conversion to a linked executable plan', async () => {
  const f = fixture({ 'research/assets/main_theorem.md': asset() });
  const ideaId = await f.core.saveIdea('Try reflexivity', 'A possibly useful observation.', ['main_theorem']);
  const planId = await f.core.convertIdea(ideaId, 'main_theorem', 'Prove reflexivity', 'Check the assumptions\nApply equality', 'Verify each equality step');
  assert.equal(matter(f.map.get(`research/ideas/${ideaId}.md`)).data.type, 'idea');
  assert.deepEqual([matter(f.map.get(`research/ideas/${ideaId}.md`)).data.status, matter(f.map.get(`research/ideas/${ideaId}.md`)).data.resolved_by], ['resolved', planId]);
  const parsed = matter(f.map.get(`research/plans/${planId}.md`));
  assert.deepEqual(parsed.data.inspired_by, [ideaId]);
  assert.match(parsed.content, /2\. \[ \] Apply equality/);
});

test('late answers are kept and a stopped loop clears the pending question', async () => {
  const f = fixture();
  await f.core.start('claude');
  assert.equal(f.core.current.stage, 'discuss_goals');
  const question = await f.core.askQuestion('goals', 'What is the goal?');
  await f.core.expireQuestion(question.id);
  await f.core.answerQuestion(question.id, 'answer', 'Prove reflexivity.', 'popup');
  assert.equal(f.core.current.stage, 'draft_project');
  await f.core.answerQuestion('old-question', 'answer', 'late thought', 'popup');
  assert.match(f.core.briefStatus(), /Late researcher answers/);
  await f.core.consumeAnswers();
  assert.doesNotMatch(f.core.briefStatus(), /Late researcher answers/);
  await f.core.stop();
  assert.equal(f.core.current.status, 'stopped');
});

// ---------- bundled CLI in a temporary project ----------

const cli = path.resolve(__dirname, '../out/research-loop.cjs');
function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-'));
  const config = { version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } };
  const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
  write('.research-assistant.json', JSON.stringify(config));
  write('research/project.md', '# Project\n\n## Required Results\n');
  write('research/papers.md', '# Papers\n');
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8', input });
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  return { root, write, run, read, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('CLI drives the state machine and validates files on disk', () => {
  const p = tempProject();
  try {
    assert.equal(p.run(['next']).status, 1);
    const started = p.run(['start', '--provider', 'claude', '--goal', 'Prove it', '--session', 's1']);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /draft_project/);
    p.write('research/project.md', project);
    const drafted = p.run(['report', 'complete', '--summary', 'Drafted']);
    assert.equal(drafted.status, 0, drafted.stderr);
    assert.match(drafted.stdout, /review_project/);
    assert.match(p.run(['status', '--brief']).stdout, /Waiting for researcher approval: project project/);
    const state = JSON.parse(p.read('.research-assistant-loop/state.json'));
    assert.equal(state.approvalQueue[0].kind, 'project');
    assert.equal(p.run(['report', 'complete', '--summary', 'again']).status, 1);
    const other = p.run(['next', '--session', 's2']);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /Another session/);
    assert.equal(p.run(['next', '--session', 's2', '--force']).status, 0);
    assert.equal(p.run(['pause']).status, 0);
    assert.match(p.run(['next']).stdout, /paused/);
    const idea = p.run(['idea', 'add', '--title', 'Hunch', '--body', 'Try induction.', '--json']);
    assert.equal(idea.status, 0, idea.stderr);
    assert.match(p.read(`research/ideas/${JSON.parse(idea.stdout).ideaId}.md`), /origin: researcher/);
    p.write('research/assets/forged.md', asset('', { status: 'approved' }));
    assert.equal(p.run(['validate']).status, 1);
    assert.equal(p.run(['validate', '--fix']).status, 0);
    assert.match(p.read('research/assets/forged.md'), /status: draft/);
  } finally { p.cleanup(); }
});

test('CLI extend reopens an approved project for a new goal', () => {
  const p = tempProject();
  try {
    p.write('research/project.md', project);
    p.write('research/approvals.json', JSON.stringify({ version: 1, records: [{ kind: 'project', target: 'project', digest: researchDigest(project, 'project'), approvedAt: 'now' }] }));
    const extended = p.run(['extend', '--goal', 'New conjecture', '--provider', 'codex']);
    assert.equal(extended.status, 0, extended.stderr);
    assert.match(extended.stdout, /draft_project/);
    assert.match(extended.stdout, /keep every existing required_results entry/);
    p.write('research/project.md', extendedProject);
    const drafted = p.run(['report', 'complete', '--summary', 'Added']);
    assert.equal(drafted.status, 0, drafted.stderr);
    assert.match(drafted.stdout, /review_project/);
  } finally { p.cleanup(); }
});

test('shared records rebuild parked assets, falsification, and failure counts when state.json is gone', async () => {
  const f = fixture();
  await driveToPlan(f);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const difference = attempt > 1 ? `\n## Difference from failed plans\n\n${Array.from({ length: attempt - 1 }, (_, i) => `- attempt_${i + 1}: different route`).join('\n')}\n` : '';
    f.map.set(`research/plans/attempt_${attempt}.md`, plan(`attempt_${attempt}`, 'pending', difference));
    await f.core.report({ outcome: 'complete', summary: 'Planned', planId: `attempt_${attempt}` });
    f.map.set(`research/plans/attempt_${attempt}.md`, plan(`attempt_${attempt}`, 'failed', difference));
    await f.core.report({ outcome: 'failed', summary: 'Obstructed' });
  }
  await f.core.answerQuestion(f.core.current.pendingQuestion.id, 'answer', 'Try a compactness argument.', 'popup');
  await f.core.park('main_theorem', 'assumption A3 unclear', 'Ask Alice about A3.');
  // A collaborator's fresh clone: same files, no local loop state.
  for (const file of [...f.map.keys()]) if (file.startsWith('.research-assistant-loop/')) f.map.delete(file);
  const fresh = new ResearchLoopCore(f.files, paths, { id: () => `id-${++counter}` });
  await fresh.load();
  await fresh.start('claude');
  assert.deepEqual(fresh.current.parked.main_theorem, { reason: 'assumption A3 unclear', at: fresh.current.parked.main_theorem.at, note: 'Ask Alice about A3.' });
  assert.equal(fresh.current.stage, 'waiting');
  await fresh.unpark('main_theorem');
  // The falsification check still covers the unchanged statement, so the loop plans instead of re-falsifying.
  assert.equal((await fresh.next()).stage, 'plan');
  // The direction answered the three failures; one new failure must not re-trigger the blocked question.
  f.map.set('research/plans/attempt_4.md', plan('attempt_4', 'pending', '\n## Difference from failed plans\n\n- attempt_1, attempt_2, attempt_3: compactness instead\n'));
  await fresh.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_4' });
  f.map.set('research/plans/attempt_4.md', plan('attempt_4', 'failed', '\n## Difference from failed plans\n\n- attempt_1, attempt_2, attempt_3: compactness instead\n'));
  const result = await fresh.report({ outcome: 'failed', summary: 'Obstructed' });
  assert.match(result.message, /\(1\/3\)/);
  assert.equal(fresh.current.pendingQuestion, undefined);
  // A changed statement is no longer covered by the old check.
  f.map.set('research/assets/main_theorem.md', asset('', { title: 'Main theorem', tags: ['changed'] }).replace('n = n.', 'n + 0 = n.'));
  await fresh.stop();
  await fresh.start('claude', { force: true });
  assert.equal(fresh.current.stage, 'falsify');
});

test('next attaches the stage context pack and worker tier to the brief', async () => {
  const f = fixture();
  await driveToPlan(f);
  const next = await f.core.next();
  assert.equal(next.stage, 'plan');
  assert.equal(next.brief.worker, 'deep');
  assert.ok(next.brief.context.items.includes('main_theorem#statement'));
  assert.match(next.instruction, /plan-proof skill/);
  assert.match(next.instruction, /research-worker-deep/);
  const pack = f.map.get('.research-assistant-loop/context/current.md');
  assert.match(pack, /For every natural number n, n = n\./);
  assert.match(pack, /falsify → none: No counterexample/);
  const manifest = JSON.parse(f.map.get('.research-assistant-loop/context/current.json'));
  assert.equal(manifest.stageStartedAt, f.core.current.current.stageStartedAt);
  assert.ok(manifest.files.includes('research/assets/main_theorem.md'));
});
