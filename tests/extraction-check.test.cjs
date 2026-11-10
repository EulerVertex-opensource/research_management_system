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
const { DEFAULT_LOOP_SETTINGS, RIGOR_PRESETS, normalizeLoopSettings, rigorPreset } = load('../src/domain/loopSettings.ts');
const { roleSignal, teachingToolDecision, writingToolDecision } = load('../src/services/ResearchLoopHooks.ts');
const { CONTEXT_PACK_PATH, STATE_PATH } = load('../src/services/ResearchLoopModel.ts');
const { Teaching } = load('../src/services/Teaching.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const SETTINGS = '.research-assistant-loop/settings.json';
const MAIN = 'research/assets/main_theorem.md';
const NATURAL = 'research/definitions/natural.md';
const PROOF = '\n## Proof\n\nBy reflexivity of equality, n = n for every natural number n.\n';
/** A result as the researcher's manuscript gives it: statement and proof. */
const theorem = (proof = PROOF, extra = {}) => matter.stringify(`\n## Statement\n\nFor every natural number n, n = n.\n${proof}`, { type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: ['natural'], tags: [], ...extra });
const definition = (text = 'A natural number is a member of N.') => matter.stringify(`\n${text}\n`, { type: 'definition', title: 'Definition (natural)', status: 'draft', depends_on: [] });
const settings = (rigor = {}, extra = {}) => JSON.stringify({ version: 1, rigor: { refuteSearch: 'off', ...rigor }, ...extra });

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    appendFile: async (file, content) => { map.set(file, (map.get(file) ?? '') + content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
    deleteFile: async (file) => { map.delete(file); },
  };
}

let counter = 0;
function fixture(settingsText = settings(), initial = {}) {
  const files = memoryFiles({ 'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n', [SETTINGS]: settingsText, ...initial });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map };
}

const decisions = (f, kind) => [...f.map.entries()].filter(([file]) => file.startsWith('research/decisions/')).map(([, raw]) => matter(raw)).filter((item) => !kind || item.data.kind === kind);
const status = (f, file) => matter(f.map.get(file)).data.status;
const events = (f, type) => (f.map.get('.research-assistant-loop/events.jsonl') ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === type);

/** Goals approved by hand; the scaffold stage writes `scaffold`; sources finds none. */
async function driveToSelect(f, scaffold) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  for (const [file, content] of Object.entries(scaffold)) f.map.set(file, content);
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
}

/** Confirm every check the loop asks for; returns the stage after them. */
async function confirmChecks(f) {
  let next = await f.core.next();
  while (next.stage === 'verify_node') {
    await f.core.report({ outcome: 'confirmed', summary: `Checked ${f.core.current.current.node.id}.` });
    next = await f.core.next();
  }
  return next;
}

// ---------- the setting ----------

test('Careful checks extracted results, Fast does not; an older Fast settings file stays Fast', () => {
  assert.equal(DEFAULT_LOOP_SETTINGS.rigor.verifyExtracted, 'agent');
  assert.equal(RIGOR_PRESETS.fast.verifyExtracted, 'off');
  const oldFast = normalizeLoopSettings({ rigor: { refuteSearch: 'main', verifyProofs: 'off', agreeDefinitions: 'off', onDependencyChange: 'flag' } }).settings.rigor;
  assert.equal(oldFast.verifyExtracted, 'off');
  assert.equal(rigorPreset(oldFast), 'fast');
  const oldCareful = normalizeLoopSettings({ rigor: { refuteSearch: 'all', verifyProofs: 'agent', agreeDefinitions: 'main', onDependencyChange: 'revert' } }).settings.rigor;
  assert.equal(oldCareful.verifyExtracted, 'agent');
  assert.equal(rigorPreset(oldCareful), 'careful');
  assert.equal(rigorPreset({ ...oldCareful, verifyExtracted: 'off' }), 'custom');
});

// ---------- never the loop's chat ----------

test('research-loop check never makes a chat the loop\'s driver; a writing chat may run it, a teaching chat may not', () => {
  const loop = 'node .agents/skills/research-loop/scripts/research-loop.cjs';
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  for (const command of ['check next --ids natural,main_theorem --source research/papers/notes.md', 'check verdict natural confirmed --summary "ok"', 'check coverage --source x --ids a complete --summary "ok"']) {
    assert.equal(roleSignal('PreToolUse', bash(`${loop} ${command}`), /teach/), undefined, command);
    assert.equal(writingToolDecision(bash(`${loop} ${command}`)).deny, false, command);
    assert.equal(teachingToolDecision(paths, bash(`${loop} ${command}`), '/work/project').deny, true, command);
  }
  assert.equal(roleSignal('PreToolUse', bash(`${loop} report confirmed --summary "ok"`), /teach/), 'drive', 'report still drives');
});

test('checks run beside a running loop leave its state, lock, and context pack alone', async () => {
  const f = fixture();
  await f.core.start('claude', { goal: 'Prove the main theorem.', sessionId: 'loop-chat' });
  await f.core.next();
  const stateBefore = f.map.get(STATE_PATH);
  const packBefore = f.map.get(CONTEXT_PACK_PATH);
  // The researcher's manuscript, extracted in another chat.
  f.map.set(NATURAL, definition());
  f.map.set(MAIN, theorem());
  f.map.set('research/assets/key_lemma.md', theorem('', { title: 'Key lemma', type: 'lemma', uses_definitions: [] }));
  const other = new ResearchLoopCore(f.files, paths, { id: () => `id-${++counter}` });
  await other.load();
  const plan = await other.extractionChecks(['main_theorem', 'natural', 'key_lemma', 'ghost']);
  assert.equal(plan.enabled, true);
  assert.deepEqual(plan.pending, [{ id: 'natural', mode: 'definition' }, { id: 'main_theorem', mode: 'proof' }], 'definitions first');
  assert.deepEqual(plan.skipped.map((item) => item.id), ['key_lemma', 'ghost']);
  assert.match(plan.skipped[0].why, /no proof yet/);
  const task = await other.extractionCheckTask(plan.pending[1]);
  assert.equal(task.file, '.research-assistant-loop/checks/main_theorem.md');
  assert.match(f.map.get(task.file), /By reflexivity of equality/);
  assert.match(f.map.get(task.file), /A natural number is a member of N/, 'the definitions it uses');
  assert.match(task.instruction, /check verdict main_theorem confirmed/);
  await assert.rejects(other.recordExtractionCheck('natural', 'confirmed', ''), /--summary/);
  await assert.rejects(other.recordExtractionCheck('key_lemma', 'confirmed', 'x'), /nothing to check/);
  await other.recordExtractionCheck('natural', 'confirmed', 'Well formed.');
  assert.match(await other.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 assumes n is finite.'), /did not pass/);
  const [proofCheck] = decisions(f, 'proof_check');
  assert.equal(proofCheck.data.reason, 'rejected');
  assert.ok(proofCheck.data.statement_digest);
  assert.deepEqual(Object.keys(proofCheck.data.dependency_digests), ['natural']);
  assert.equal(decisions(f, 'node_check')[0].data.reason, 'confirmed');
  const again = await other.extractionChecks(['main_theorem', 'natural']);
  assert.deepEqual(again.pending, []);
  assert.deepEqual(again.checked.map((item) => `${item.id} ${item.verdict}`).sort(), ['main_theorem rejected', 'natural confirmed']);
  assert.equal(f.map.get(STATE_PATH), stateBefore, 'the loop state is untouched');
  assert.equal(f.map.get(CONTEXT_PACK_PATH), packBefore, 'the loop pack is untouched');
  assert.equal(JSON.parse(f.map.get(STATE_PATH)).lock.sessionId, 'loop-chat');
  assert.equal(events(f, 'proof_checked')[0].from, 'extraction');
});

test('a changed proof, statement, or definition needs a new check', async () => {
  const f = fixture(settings(), { [NATURAL]: definition(), [MAIN]: theorem() });
  await f.core.extractionChecks([]);
  await f.core.recordExtractionCheck('main_theorem', 'confirmed', 'Every step follows.');
  assert.deepEqual((await f.core.extractionChecks(['main_theorem'])).pending, []);
  f.map.set(NATURAL, definition('A natural number is a positive member of N.'));
  assert.deepEqual((await f.core.extractionChecks(['main_theorem'])).pending, [{ id: 'main_theorem', mode: 'proof' }], 'the definition it read changed');
  f.map.set(NATURAL, definition());
  assert.deepEqual((await f.core.extractionChecks(['main_theorem'])).pending, []);
  f.map.set(MAIN, theorem('\n## Proof\n\nTrivial.\n'));
  assert.deepEqual((await f.core.extractionChecks(['main_theorem'])).pending, [{ id: 'main_theorem', mode: 'proof' }], 'the proof changed');
});

test('with the setting off, check next says nothing needs checking', async () => {
  const f = fixture(settings({ verifyExtracted: 'off' }), { [MAIN]: theorem() });
  assert.equal((await f.core.extractionChecks(['main_theorem'])).enabled, false);
});

// ---------- what a verdict does ----------

test('auto mode approves a manuscript proof once its check confirms it; a rejected one waits with the verdict and keeps its proof', async () => {
  const f = fixture(settings({}, { autoApprove: { enabled: true } }));
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(NATURAL, definition());
  f.map.set(MAIN, theorem());
  await f.core.recordExtractionCheck('natural', 'confirmed', 'Well formed.');
  await f.core.recordExtractionCheck('main_theorem', 'confirmed', 'Every step follows.');
  assert.equal((await f.core.requestApproval('definition', 'natural', 'Extracted from the manuscript.')).status, 'auto_approved');
  assert.equal((await f.core.requestApproval('asset', 'main_theorem', 'Extracted from the manuscript.')).status, 'auto_approved');
  assert.equal(status(f, MAIN), 'approved');

  const rejected = fixture(settings({}, { autoApprove: { enabled: true } }));
  await rejected.core.start('claude', { goal: 'Prove the main theorem.' });
  rejected.map.set(NATURAL, definition());
  rejected.map.set(MAIN, theorem());
  await rejected.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 assumes n is finite.');
  const outcome = await rejected.core.requestApproval('asset', 'main_theorem', 'Extracted from the manuscript.');
  assert.equal(outcome.status, 'queued');
  assert.match(outcome.request.reason, /the agent's check found a problem: Step 1 assumes n is finite/);
  assert.match(rejected.map.get(MAIN), /## Proof/, 'the researcher\'s proof stays');
});

test('without auto mode the researcher reviews with the verdict; a verdict after the request goes on it too', async () => {
  const f = fixture();
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(NATURAL, definition());
  f.map.set(MAIN, theorem());
  await f.core.recordExtractionCheck('natural', 'confirmed', 'Well formed.');
  const outcome = await f.core.requestApproval('definition', 'natural', 'Extracted from the manuscript.');
  assert.equal(outcome.status, 'queued');
  assert.match(outcome.request.reason, /an independent agent's check confirmed it/);
  await f.core.requestApproval('asset', 'main_theorem', 'Extracted from the manuscript.');
  await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 assumes n is finite.');
  const request = f.core.current.approvalQueue.find((item) => item.target === 'main_theorem');
  assert.match(request.reason, /^Extracted from the manuscript\. \(the agent's check found a problem: Step 1/);
  assert.equal(status(f, MAIN), 'draft');
});

// ---------- coverage ----------

test('each batch gets one coverage check; after two that found gaps the rest goes to the researcher', async () => {
  const f = fixture(settings(), { [NATURAL]: definition(), [MAIN]: theorem() });
  const source = 'research/papers/manuscript/transcription.md';
  assert.equal((await f.core.coverageDue(source, ['natural', 'main_theorem'])).due, true);
  const task = await f.core.coverageTask(source, ['natural', 'main_theorem']);
  assert.match(f.map.get(task.file), /## main_theorem \(theorem\): Main theorem/);
  assert.match(f.map.get(task.file), /uses_definitions: natural/);
  assert.match(task.instruction, /check coverage --source/);
  await assert.rejects(f.core.recordCoverage(source, ['natural', 'main_theorem'], 'gaps', ''), /--summary/);
  await f.core.recordCoverage(source, ['natural', 'main_theorem'], 'gaps', 'Lemma 2 (p. 3) has no node.');
  assert.equal((await f.core.coverageDue(source, ['main_theorem', 'natural'])).due, false, 'the same batch, in any order');
  assert.equal((await f.core.coverageDue(source, ['natural', 'main_theorem', 'lemma_two'])).due, true, 'after the gaps are filled');
  await f.core.recordCoverage(source, ['natural', 'main_theorem', 'lemma_two'], 'gaps', 'Remark 4 claims sharpness; no node.');
  const capped = await f.core.coverageDue(source, ['natural', 'main_theorem', 'lemma_two', 'remark_four']);
  assert.equal(capped.due, false);
  assert.match(capped.last.text, /Remark 4/);
  assert.equal(events(f, 'coverage_checked').length, 2);
});

// ---------- inside the loop ----------

test('what the scaffold stage extracts is checked before anything else, also without auto mode', async () => {
  const f = fixture();
  await driveToSelect(f, { [NATURAL]: definition(), [MAIN]: theorem() });
  assert.deepEqual([...f.core.current.extractedChecks].sort(), ['main_theorem', 'natural']);
  const first = await f.core.next();
  assert.equal(first.stage, 'verify_node');
  assert.deepEqual(f.core.current.current.node, { id: 'natural', mode: 'definition' });
  assert.match(first.instruction, /The researcher reviews it with your verdict/);
  await f.core.report({ outcome: 'confirmed', summary: 'Well formed.' });
  const second = await f.core.next();
  assert.equal(second.stage, 'verify_node');
  assert.deepEqual(f.core.current.current.node, { id: 'main_theorem', mode: 'proof' });
  assert.match(second.instruction, /the proof of main_theorem as written/);
  const pack = await f.core.contextPack();
  assert.match(pack.text, /By reflexivity of equality/);
  await f.core.report({ outcome: 'rejected', summary: 'Step 1 assumes n is finite.' });
  assert.equal(f.core.current.extractedChecks, undefined);
  assert.equal((await f.core.next()).stage, 'waiting');
  const natural = f.core.current.approvalQueue.find((item) => item.target === 'natural');
  assert.match(natural.reason, /an independent agent's check confirmed it/);
  assert.equal(status(f, NATURAL), 'draft', 'nothing is approved without auto mode');
  // Agreed by the researcher: the main theorem comes to them with its verdict, and is not checked again.
  await f.core.resolveApproval(natural.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'waiting');
  assert.match(f.core.current.approvalQueue.find((item) => item.target === 'main_theorem').reason, /the agent's check found a problem: Step 1/);
});

test('with the setting off, the scaffold stage\'s nodes go to the researcher unchecked', async () => {
  const f = fixture(settings({ verifyExtracted: 'off' }));
  await driveToSelect(f, { [NATURAL]: definition(), [MAIN]: theorem() });
  assert.equal(f.core.current.extractedChecks, undefined);
  assert.equal((await f.core.next()).stage, 'waiting');
  assert.equal(decisions(f).length, 0);
});

test('a checked manuscript proof is checked again when a definition it uses changes; a failed re-check keeps the proof for the researcher', async () => {
  for (const verdict of ['confirmed', 'rejected']) {
    const f = fixture(settings({ verifyProofs: 'off', onDependencyChange: 'flag', agreeDefinitions: 'off' }, { autoApprove: { enabled: true } }));
    await driveToSelect(f, { [NATURAL]: definition(), [MAIN]: theorem() });
    await confirmChecks(f);
    assert.equal(status(f, MAIN), 'approved', 'approved on its proof check');
    assert.equal(status(f, NATURAL), 'approved');
    f.map.set(NATURAL, f.map.get(NATURAL).replace('a member of N', 'a positive member of N'));
    await f.core.reconcile('natural');
    f.core.current.stage = 'select';
    // The edited definition itself is the researcher's to review; the proof that uses it is re-checked meanwhile.
    const next = await f.core.next();
    assert.equal(next.stage, 'verify_node', verdict);
    assert.deepEqual(f.core.current.current.node, { id: 'main_theorem', mode: 'proof', changed: ['natural'] });
    assert.match(next.instruction, /This is a re-check: natural changed/);
    assert.match((await f.core.contextPack()).text, /Re-check: natural changed/);
    const done = await f.core.report({ outcome: verdict, summary: verdict === 'confirmed' ? 'Every step still holds.' : 'Step 1 needs n > 0 now.' });
    if (verdict === 'confirmed') {
      assert.match(done.message, /re-check mark is cleared/);
      assert.equal(status(f, MAIN), 'approved');
      assert.equal(JSON.parse(f.map.get('.research-assistant-loop/auto-holds.json'))['asset:main_theorem'], undefined);
      assert.equal(events(f, 'proof_checked').at(-1).from, 'recheck');
    } else {
      assert.match(done.message, /the proof stays for the researcher/);
      assert.equal(status(f, MAIN), 'draft');
      assert.match(f.map.get(MAIN), /## Proof/);
      const holds = JSON.parse(f.map.get('.research-assistant-loop/auto-holds.json'));
      assert.equal(holds['asset:main_theorem'].reason, 'dependency_changed');
      assert.equal(events(f, 'recheck_rejected')[0].kept, true);
      assert.match(f.core.current.approvalQueue.find((item) => item.target === 'main_theorem').reason, /found a problem: Step 1 needs n > 0/);
      f.core.current.stage = 'select';
      assert.notEqual((await f.core.next()).stage, 'verify_node', 'the same version is not checked again');
    }
  }
});

test('the teaching chat counts a manuscript proof as verified once its check confirms it, and not after what it uses changed', async () => {
  const f = fixture(settings(), { [NATURAL]: definition(), [MAIN]: theorem() });
  const teaching = new Teaching(f.files, paths);
  const verified = async () => (await teaching.overview()).items.filter((item) => item.id === 'main_theorem').map((item) => item.verified);
  assert.deepEqual(await verified(), []);
  await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 assumes n is finite.');
  assert.deepEqual(await verified(), [], 'a rejected check vouches for nothing');
  await f.core.recordExtractionCheck('main_theorem', 'confirmed', 'Every step follows.');
  assert.deepEqual(await verified(), ['checked']);
  f.map.set(NATURAL, definition('A natural number is a positive member of N.'));
  assert.deepEqual(await verified(), []);
});

test('an extraction check whose inputs change before its verdict is not recorded; a fresh check is', async () => {
  const { statementDigest } = load('../src/domain/digests.ts');
  const f = fixture(settings(), { [NATURAL]: definition(), [MAIN]: theorem() });
  await f.core.extractionCheckTask({ id: 'main_theorem', mode: 'proof' });
  await f.core.extractionCheckTask({ id: 'natural', mode: 'definition' });
  // The checker read the old definition; the researcher sharpens it before the verdicts come back.
  f.map.set(NATURAL, definition('A natural number is a positive member of N.'));
  await assert.rejects(f.core.recordExtractionCheck('main_theorem', 'confirmed', 'Every step follows.'), /natural changed since the check of main_theorem began[\s\S]*do not revert it/);
  await assert.rejects(f.core.recordExtractionCheck('natural', 'confirmed', 'Well formed.'), /natural changed since the check of natural began/);
  assert.deepEqual(decisions(f, 'proof_check'), []);
  assert.deepEqual(decisions(f, 'node_check'), []);
  // A fresh task freezes the current version, and the verdict is stamped with what it read.
  await f.core.extractionCheckTask({ id: 'main_theorem', mode: 'proof' });
  await f.core.recordExtractionCheck('main_theorem', 'confirmed', 'Every step follows.');
  assert.equal(decisions(f, 'proof_check')[0].data.dependency_digests.natural, statementDigest(f.map.get(NATURAL)));
  assert.equal(f.map.has('.research-assistant-loop/checks/main_theorem.inputs.json'), false, 'the frozen inputs go with the recorded verdict');
});
