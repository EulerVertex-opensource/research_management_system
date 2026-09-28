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
const { requiredAssetIds, researchDigest, statementDigest, validateResearchFile, safeRelativeFile } = load('../src/services/ResearchLoopModel.ts');
const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '# Project\n\n## Main Problem\n\nProve A.\n\n## Current Goals\n\nFind a proof.\n\n## Required Results\n\n- main_theorem: the central claim\n\n## Known Results\n\nNone.\n';
const asset = (proof = '', extra = {}) => matter.stringify(`\n## Statement\n\nFor every natural number n, n = n.\n${proof}`, { type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const plan = (id, status = 'pending', difference = '') => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\nProve reflexivity.\n\n## Plan\n\n1. [ ] Apply equality reflexivity.\n\n## Verification\n\nCheck the equality.\n${difference}${status === 'failed' ? '\n## Failure\n\nThis approach cannot establish the needed equality.\n' : ''}`, { type: 'plan', title: id, status, target_asset: 'main_theorem', inspired_by: [], tags: [] });
const record = (id) => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\n## Plan\n\n1. [x] Apply reflexivity.\n\n## Verification\n\nCheck the equality.\n\n## Outcome\n\nProof incorporated into main_theorem.\n`, { type: 'proof_record', title: id, target_asset: 'main_theorem', inspired_by: [], tags: [] });

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
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
  await f.core.report({ outcome: 'none', summary: 'No counterexample' });
  assert.equal(f.core.current.stage, 'plan');
}

test('required results, digests, and validators', () => {
  assert.deepEqual(requiredAssetIds(project), ['main_theorem']);
  assert.notEqual(researchDigest(asset(), 'asset'), researchDigest(asset('\n## Proof\n\nNew proof.\n'), 'asset'));
  assert.equal(statementDigest(asset()), statementDigest(asset('\n## Proof\n\nNew proof.\n')));
  const withLink = asset().replace('natural number', '[natural number](../definitions/natural.md)');
  assert.equal(researchDigest(asset(), 'asset'), researchDigest(withLink, 'asset'));
  assert.equal(researchDigest(project, 'project'), researchDigest(project + '\n## Writing Status\n\nlater\n', 'project'));
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
  f.map.set('research/plans/attempt_1.md', record('attempt_1'));
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

test('execution may not change the statement, and failed plans need a difference section', async () => {
  const f = fixture();
  await driveToPlan(f);
  f.map.set('research/plans/attempt_1.md', plan('attempt_1'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  f.map.set('research/assets/main_theorem.md', asset('\n## Proof\n\nDone.\n').replace('n = n', 'n = n + 0'));
  f.map.set('research/plans/attempt_1.md', record('attempt_1'));
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

test('agent-set approvals are reverted and dependency statement changes invalidate dependants', async () => {
  const f = fixture({ 'research/assets/main_theorem.md': asset('', { status: 'approved', depends_on: ['key_lemma'] }), 'research/assets/key_lemma.md': matter.stringify('\n## Statement\n\nA lemma.\n', { type: 'lemma', title: 'Key lemma', status: 'approved', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [] }) });
  await f.core.start('codex');
  const adopted = JSON.parse(f.map.get('research/approvals.json')).records.map((entry) => entry.target).sort();
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
