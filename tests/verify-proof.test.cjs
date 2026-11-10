const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const { searchNothing } = require('./search-fixtures.cjs');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { preToolUseDecision } = load('../src/services/ResearchLoopHooks.ts');
const { DEFAULT_LOOP_SETTINGS, rigorPreset } = load('../src/domain/loopSettings.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const asset = (extra = {}) => matter.stringify('\n## Statement\n\nFor every natural number n, n = n.\n', { type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const plan = (id, failed = []) => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\nProve reflexivity.\n\n## Plan\n\n1. [ ] Apply equality reflexivity.\n\n## Verification\n\nCheck the equality.\n${failed.length ? `\n## Difference from failed plans\n\nUnlike ${failed.join(', ')}, it states each step.\n` : ''}`, { type: 'plan', title: id, status: 'pending', target_asset: 'main_theorem', inspired_by: [], tags: [] });
const SETTINGS = '.research-assistant-loop/settings.json';
const ASSET = 'research/assets/main_theorem.md';
const settings = (verifyProofs, extra = {}) => JSON.stringify({ version: 1, rigor: { verifyProofs }, ...extra });

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

/** Auto mode approves a definition or citation only after an independent check: confirm each one the loop asks for. */
async function confirmNodeChecks(f) {
  let next = await f.core.next();
  while (next.stage === 'verify_node') {
    await f.core.report({ outcome: 'confirmed', summary: `Checked ${f.core.current.current.node.id}.` });
    next = await f.core.next();
  }
  return next;
}

let counter = 0;
function fixture(settingsText) {
  const files = memoryFiles({ 'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n', ...(settingsText ? { [SETTINGS]: settingsText } : {}) });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map };
}

/** Goals approved, main_theorem scaffolded, searched, planned, and proved by `planId`. */
async function proveOnce(f, planId = 'attempt_1', failed = [], scaffold = { [ASSET]: asset() }) {
  if (!f.core.current) {
    await f.core.start('claude', { goal: 'Prove the main theorem.' });
    f.map.set(paths.projectMd, project);
    await f.core.report({ outcome: 'complete', summary: 'Drafted' });
    const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
    if (request) await f.core.resolveApproval(request.id, 'approved', '', 'test');
    assert.equal((await f.core.next()).stage, 'scaffold');
    for (const [file, content] of Object.entries(scaffold)) f.map.set(file, content);
    await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
    await f.core.report({ outcome: 'none', summary: 'No sources' });
    assert.equal((await confirmNodeChecks(f)).stage, 'search');
    await searchNothing(f);
  }
  assert.equal(f.core.current.stage, 'plan');
  f.map.set(`research/plans/${planId}.md`, plan(planId, failed));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId });
  f.map.set(ASSET, f.map.get(ASSET).replace(/\n## Proof[\s\S]*$/, '') + `\n## Proof\n\nEquality is reflexive (${planId}).\n`);
  const done = matter(f.map.get(`research/plans/${planId}.md`));
  f.map.set(`research/plans/${planId}.md`, matter.stringify(done.content + '\n## Outcome\n\nProof incorporated into main_theorem.\n', { ...done.data, status: 'succeeded' }));
  return f.core.report({ outcome: 'proved', summary: 'Proved' });
}

/** The verifier's only edit: a ## Verdict at the end of the plan. */
function writeVerdict(f, planId, verdict) {
  const file = `research/plans/${planId}.md`;
  f.map.set(file, f.map.get(file).trimEnd() + `\n\n## Verdict\n\n${verdict}\n`);
}

const planData = (f, planId) => matter(f.map.get(`research/plans/${planId}.md`)).data;
const queued = (f) => f.core.current.approvalQueue.map((item) => `${item.kind}:${item.target}`);

test('Careful verifies every proof by default; Fast does not', () => {
  assert.equal(DEFAULT_LOOP_SETTINGS.rigor.verifyProofs, 'agent');
  assert.equal(rigorPreset({ ...DEFAULT_LOOP_SETTINGS.rigor, verifyProofs: 'off' }), 'custom');
});

test('a proof goes to an independent check before approval, and a confirmed one is approved in auto mode', async () => {
  const f = fixture(settings('agent', { autoApprove: { enabled: true } }));
  const proved = await proveOnce(f);
  assert.equal(proved.stage, 'verify_proof');
  assert.deepEqual(queued(f), [], 'nothing is queued before the check');
  const next = await f.core.next();
  assert.match(next.instruction, /verify-proof skill/);
  const pack = (await f.core.contextPack()).text;
  assert.match(pack, /Equality is reflexive/, 'the verifier sees the proof');
  assert.doesNotMatch(pack, /Apply equality reflexivity/, 'but not the plan behind it');
  writeVerdict(f, 'attempt_1', 'confirmed\n\nEach step follows from reflexivity.');
  const result = await f.core.report({ outcome: 'confirmed', summary: 'Checked' });
  assert.match(result.message, /verified independently and approved automatically/);
  assert.ok(planData(f, 'attempt_1').verified_proof_digest);
  assert.equal(matter(f.map.get(ASSET)).data.status, 'approved');
});

test('without auto mode, a confirmed proof waits for the researcher', async () => {
  const f = fixture(settings('agent'));
  await proveOnce(f);
  writeVerdict(f, 'attempt_1', 'confirmed');
  await f.core.report({ outcome: 'confirmed', summary: 'Checked' });
  assert.deepEqual(queued(f), ['asset:main_theorem']);
});

test('a rejected proof fails its plan, leaves the asset, and the loop plans again', async () => {
  const f = fixture(settings('agent', { maxFailedPlans: 3 }));
  await proveOnce(f);
  writeVerdict(f, 'attempt_1', 'rejected\n\nStep 1 assumes what it proves.');
  const result = await f.core.report({ outcome: 'rejected', summary: 'Gap in step 1' });
  assert.equal(result.stage, 'plan');
  assert.match(result.message, /rejected the proof from attempt_1 \(1\/3\)/);
  const failed = matter(f.map.get('research/plans/attempt_1.md'));
  assert.equal(failed.data.status, 'failed');
  assert.match(failed.content, /## Failure/);
  assert.match(failed.content, /## Verdict\n\nrejected/);
  assert.doesNotMatch(f.map.get(ASSET), /## Proof/);
  assert.deepEqual(queued(f), []);
  // The next attempt is checked again from scratch.
  assert.equal((await proveOnce(f, 'attempt_2', ['attempt_1'])).stage, 'verify_proof');
});

test('the verdict must match the outcome, and the verifier may change only the plan', async () => {
  const f = fixture(settings('agent'));
  await proveOnce(f);
  await assert.rejects(f.core.report({ outcome: 'confirmed', summary: 'x' }), /needs a ## Verdict/);
  writeVerdict(f, 'attempt_1', 'rejected\n\nA gap.');
  await assert.rejects(f.core.report({ outcome: 'confirmed', summary: 'x' }), /must begin with confirmed/);
  const verdictPlan = f.map.get('research/plans/attempt_1.md');
  f.map.set(ASSET, f.map.get(ASSET).replace('Equality is reflexive', 'Equality is obviously reflexive'));
  await assert.rejects(f.core.report({ outcome: 'rejected', summary: 'x' }), /not writable during stage verify_proof/);
  f.map.set(ASSET, f.map.get(ASSET).replace('Equality is obviously reflexive', 'Equality is reflexive'));
  f.map.set('research/plans/attempt_1.md', verdictPlan.replace('status: succeeded', 'status: pending'));
  await assert.rejects(f.core.report({ outcome: 'rejected', summary: 'x' }), /leaving its status succeeded/);
});

test('when the researcher verifies proofs, auto mode never approves one', async () => {
  const f = fixture(settings('researcher', { autoApprove: { enabled: true } }));
  const proved = await proveOnce(f);
  assert.equal(proved.stage, 'select');
  assert.deepEqual(queued(f), ['asset:main_theorem']);
  assert.equal(matter(f.map.get(ASSET)).data.status, 'draft');
});

test('with no separate check, auto mode approves the proof as before', async () => {
  const f = fixture(settings('off', { autoApprove: { enabled: true } }));
  const proved = await proveOnce(f);
  assert.match(proved.message, /approved automatically/);
  assert.equal(matter(f.map.get(ASSET)).data.status, 'approved');
});

test('turning the check on sends a proof already waiting for approval to verification first', async () => {
  const f = fixture(settings('off'));
  await proveOnce(f);
  assert.deepEqual(queued(f), ['asset:main_theorem']);
  f.map.set(SETTINGS, settings('agent', { autoApprove: { enabled: true } }));
  const next = await f.core.next();
  assert.equal(next.stage, 'verify_proof');
  assert.equal(matter(f.map.get(ASSET)).data.status, 'draft', 'auto mode waits for the check');
});

test('agents may not stamp a proof as verified', () => {
  const deny = (input) => preToolUseDecision(paths, input).deny;
  assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: 'research/plans/attempt_1.md', old_string: 'status: succeeded', new_string: 'status: succeeded\nverified_proof_digest: abc' } }), true);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: "sed -i 's/^tags:/verified_proof_digest: abc\\ntags:/' research/plans/attempt_1.md" } }), true);
  assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: 'research/plans/attempt_1.md', old_string: 'x', new_string: '## Verdict\n\nconfirmed' } }), false);
});

const DEFINITION = 'research/definitions/natural.md';
const definition = (text) => matter.stringify(`\n${text}\n`, { type: 'definition', title: 'Definition (natural)', status: 'draft', source: { kind: 'original' }, depends_on: [] });
const withDefinition = { [ASSET]: asset({ uses_definitions: ['natural'] }), [DEFINITION]: definition('A natural number is a non-negative integer.') };

test('a verified proof is checked again when a definition it uses changes, and an approved one marked for re-check keeps its approval', async () => {
  const f = fixture(settings('agent', { autoApprove: { enabled: true }, rigor: { verifyProofs: 'agent', onDependencyChange: 'flag' } }));
  await proveOnce(f, 'attempt_1', [], withDefinition);
  await f.core.next();
  writeVerdict(f, 'attempt_1', 'confirmed: every step follows.');
  await f.core.report({ outcome: 'confirmed', summary: 'Checked' });
  assert.equal(matter(f.map.get(ASSET)).data.status, 'approved');
  assert.equal(matter(f.map.get(DEFINITION)).data.status, 'approved');

  // The researcher sharpens the definition: main_theorem stays approved but is marked for re-check.
  f.map.set(DEFINITION, f.map.get(DEFINITION).replace('a non-negative integer', 'a positive integer'));
  await f.core.reconcile('natural');
  assert.equal((await f.core.recheckFlags()).main_theorem, 'natural');
  // The changed definition itself stays with the researcher: a main result's statement uses it.
  assert.equal((await f.core.next()).stage, 'waiting');
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.target === 'natural').id, 'approved', '', 'test');
  const next = await f.core.next();
  assert.equal(next.stage, 'verify_proof');
  assert.deepEqual(f.core.current.current.recheck, ['natural']);
  assert.match(f.map.get('research/plans/attempt_1.md'), /^## Earlier verdict/m, 'the first verdict is kept under another heading');
  writeVerdict(f, 'attempt_1', 'confirmed: reflexivity holds for positive integers too.');
  const done = await f.core.report({ outcome: 'confirmed', summary: 'Still holds' });
  assert.match(done.message, /re-check mark is cleared/);
  assert.equal(matter(f.map.get(ASSET)).data.status, 'approved');
  assert.equal((await f.core.recheckFlags()).main_theorem, undefined);
});

test('a verification no longer counts once a definition the proof uses changed', async () => {
  const f = fixture(settings('agent', { rigor: { verifyProofs: 'agent', agreeDefinitions: 'off' } }));
  await proveOnce(f, 'attempt_1', [], withDefinition);
  await f.core.next();
  writeVerdict(f, 'attempt_1', 'confirmed: every step follows.');
  await f.core.report({ outcome: 'confirmed', summary: 'Checked' });
  assert.ok(queued(f).includes('asset:main_theorem'));
  // Edited while the proof waits for the researcher (the definition is still a draft, so nothing is reverted).
  f.map.set(DEFINITION, f.map.get(DEFINITION).replace('a non-negative integer', 'a positive integer'));
  const next = await f.core.next();
  assert.equal(next.stage, 'verify_proof', 'the check was made against the old definition');
  assert.deepEqual(f.core.current.current.recheck, ['natural']);
});

// Frozen stage inputs: a verdict covers exactly what the check read; an execution works from what the result rested on when it began.
const digestOf = (raw) => load('../src/domain/digests.ts').statementDigest(raw);

test('a definition that changes during the check voids the verdict: it is set aside and the check runs again on the current version', async () => {
  const f = fixture(settings('agent', { rigor: { verifyProofs: 'agent', agreeDefinitions: 'off' } }));
  await proveOnce(f, 'attempt_1', [], withDefinition);
  assert.equal((await f.core.next()).stage, 'verify_proof');
  writeVerdict(f, 'attempt_1', 'confirmed: every step follows.');
  // The verifier read the old definition; the researcher sharpens it before the report.
  f.map.set(DEFINITION, f.map.get(DEFINITION).replace('a non-negative integer', 'a positive integer'));
  const voided = await f.core.report({ outcome: 'confirmed', summary: 'Checked' });
  assert.match(voided.message, /natural changed during the check/);
  assert.match(voided.message, /do not revert it/);
  assert.equal(voided.stage, 'verify_proof');
  assert.equal(planData(f, 'attempt_1').verified_proof_digest, undefined, 'nothing is stamped for the old check');
  assert.match(f.map.get('research/plans/attempt_1.md'), /^## Earlier verdict/m);
  assert.match(f.map.get(DEFINITION), /a positive integer/, 'the change stays');
  assert.ok(!queued(f).includes('asset:main_theorem'));
  // The check runs again and is stamped with the definition it read: the current one.
  writeVerdict(f, 'attempt_1', 'confirmed: reflexivity holds for positive integers too.');
  await f.core.report({ outcome: 'confirmed', summary: 'Checked again' });
  assert.equal(planData(f, 'attempt_1').dependency_digests.natural, digestOf(f.map.get(DEFINITION)));
  assert.ok(queued(f).includes('asset:main_theorem'));
});

test('next notices a definition that changed during the check and restarts the check with a note', async () => {
  const f = fixture(settings('agent', { rigor: { verifyProofs: 'agent', agreeDefinitions: 'off' } }));
  await proveOnce(f, 'attempt_1', [], withDefinition);
  assert.equal((await f.core.next()).stage, 'verify_proof');
  f.map.set(DEFINITION, f.map.get(DEFINITION).replace('a non-negative integer', 'a positive integer'));
  const next = await f.core.next();
  assert.equal(next.stage, 'verify_proof');
  assert.match(next.instruction, /^natural changed during the check/);
  assert.equal(f.core.current.current.inputs.find((input) => input.id === 'natural').digest, digestOf(f.map.get(DEFINITION)), 'refrozen on the current version');
});

test('a definition that changes during execution sets the plan aside, uncounted, and the result is planned anew; the change is kept', async () => {
  const f = fixture(settings('agent', { rigor: { verifyProofs: 'agent', agreeDefinitions: 'off' } }));
  await proveOnce(f, 'attempt_1', [], withDefinition);
  await f.core.next();
  writeVerdict(f, 'attempt_1', 'rejected: step 1 is circular.');
  await f.core.report({ outcome: 'rejected', summary: 'Gap' });
  assert.equal(f.core.current.stage, 'plan');
  f.map.set('research/plans/attempt_2.md', plan('attempt_2', ['attempt_1']));
  assert.equal((await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_2' })).stage, 'execute');
  // Mid-execution, the researcher edits the definition the result uses; the agent then reports a proof.
  f.map.set(DEFINITION, f.map.get(DEFINITION).replace('a non-negative integer', 'a positive integer'));
  f.map.set(ASSET, f.map.get(ASSET).replace(/\n## Proof[\s\S]*$/, '') + '\n## Proof\n\nDraft written against the old definition.\n');
  const done = matter(f.map.get('research/plans/attempt_2.md'));
  f.map.set('research/plans/attempt_2.md', matter.stringify(done.content + '\n## Outcome\n\nProof incorporated.\n', { ...done.data, status: 'succeeded' }));
  const result = await f.core.report({ outcome: 'proved', summary: 'Proved' });
  assert.equal(result.stage, 'plan');
  assert.match(result.message, /natural changed during execution/);
  assert.match(result.message, /not counted as a failed approach/);
  assert.match(result.message, /do not revert it/);
  const aside = matter(f.map.get('research/plans/attempt_2.md'));
  assert.equal(aside.data.status, 'abandoned');
  assert.equal(aside.data.proof_digest, undefined, 'the set-aside plan vouches for no proof');
  assert.match(f.map.get(DEFINITION), /a positive integer/);
  assert.match(f.map.get(ASSET), /Draft written against the old definition/, 'the draft stays for reference');
  assert.ok(!queued(f).includes('asset:main_theorem'));
});

test('the verifier still may not edit the proof under check: that is a rule violation, not a changed input', async () => {
  const f = fixture(settings('agent'));
  await proveOnce(f);
  await f.core.next();
  writeVerdict(f, 'attempt_1', 'confirmed: fine.');
  f.map.set(ASSET, f.map.get(ASSET).replace('Equality is reflexive', 'Equality is plainly reflexive'));
  await assert.rejects(f.core.report({ outcome: 'confirmed', summary: 'x' }), /not writable during stage verify_proof[\s\S]*do not revert it; ask the researcher/);
  assert.equal(planData(f, 'attempt_1').verified_proof_digest, undefined);
});
