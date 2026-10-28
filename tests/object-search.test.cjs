const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const { candidate, roundRecord, writeRound, searchNothing } = require('./search-fixtures.cjs');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const search = load('../src/domain/search.ts');
const { LOOP_NUMBER_FIELDS, DEFAULT_LOOP_SETTINGS, normalizeLoopSettings, validateSettingsPatch, applyLoopPatch } = load('../src/domain/loopSettings.ts');
const { LOOP_NUMBER_KEYS } = load('../src/models/settings.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const asset = (statement = 'For every natural number n, n = n.') => matter.stringify(`\n## Statement\n\n${statement}\n`, { type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [] });
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
function fixture(settings = {}) {
  const files = memoryFiles({ 'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n', [SETTINGS]: JSON.stringify({ version: 1, ...settings }) });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map };
}

/** Goals approved, main_theorem scaffolded, sources done: the loop is at the first search round. */
async function driveToSearch(f, content = asset()) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.kind === 'project').id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', content);
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  return f.core.next();
}

const construction = (statement = 'A group G such that:\n\n- P1: G is finite.\n- P2: G is not abelian.') => matter.stringify(`\n## Statement\n\n${statement}\n`, { type: 'construction', title: 'A small non-abelian group', status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [] });
const groupCandidate = (status = 'failed', checks = status === 'failed' ? { P1: 'pass', P2: 'fail' } : { P1: 'pass', P2: 'pass' }) => matter.stringify(
  `\n## Object\n\n${status === 'failed' ? 'The cyclic group Z/6.' : 'The symmetric group S3.'}\n\n## Checks\n\n### P1\n\nIt has 6 elements.\n\n### P2\n\n${status === 'failed' ? 'Cyclic groups are abelian.' : '(12)(13) differs from (13)(12).'}\n${status === 'failed' ? '\n## Failure\n\nP2 fails: cyclic groups are abelian.\n' : ''}`,
  { type: 'candidate', title: status === 'failed' ? 'Z/6' : 'S3', status, target_asset: 'main_theorem', checks },
);
/** Every slot of the current construct round writes one candidate; the first slot's may survive. */
function writeConstructRound(f, { survivor = false } = {}) {
  const search = f.core.current.current.search;
  for (const slot of search.slots) f.map.set(`research/candidates/cand_main_theorem_r${search.round}_s${slot.slot}_g${++counter}.md`, groupCandidate(survivor && slot.slot === 1 ? 'survived' : 'failed'));
  if (search.slots.length === 1) f.map.set(`research/checks/search_main_theorem_r${search.round}_g${++counter}.md`, roundRecord('main_theorem', 'Every cyclic group is abelian.'));
}
async function approveSpecification(f) {
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'specification');
  assert.ok(request, 'specification approval requested');
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  return f.core.next();
}

const node = (id, raw, folder) => { const parsed = matter(raw); return { id, file: `${folder}/${id}.md`, data: parsed.data, body: parsed.content }; };
const stamped = (id, raw, fields) => node(id, matter.stringify(matter(raw).content, { ...matter(raw).data, statement_digest: 'd1', ...fields }), 'research/candidates');

// ---------- settings ----------

test('every numeric loop setting has exactly one field in the settings table, with its default in range', () => {
  const keys = Object.keys(DEFAULT_LOOP_SETTINGS).filter((key) => !['version', 'autoApprove', 'rigor', 'autonomy'].includes(key)).sort();
  assert.deepEqual(keys, [...LOOP_NUMBER_KEYS].sort());
  assert.deepEqual(Object.keys(LOOP_NUMBER_FIELDS).sort(), keys);
  for (const key of LOOP_NUMBER_KEYS) {
    const field = LOOP_NUMBER_FIELDS[key];
    assert.ok(field.label && field.hint, key);
    assert.ok(field.defaultValue >= field.range[0] && field.defaultValue <= field.range[1], key);
  }
});

test('every numeric loop setting is clamped, validated, and patched through the table', () => {
  for (const key of LOOP_NUMBER_KEYS) {
    const [min, max] = LOOP_NUMBER_FIELDS[key].range;
    assert.equal(normalizeLoopSettings({ [key]: max + 1 }).settings[key], max, key);
    assert.equal(normalizeLoopSettings({ [key]: min - 1 }).settings[key], min, key);
    assert.equal(normalizeLoopSettings({ [key]: 'x' }).settings[key], LOOP_NUMBER_FIELDS[key].defaultValue, key);
    assert.deepEqual(Object.keys(validateSettingsPatch({ loop: { [key]: max + 1 } }, [])), [`loop.${key}`]);
    assert.deepEqual(validateSettingsPatch({ loop: { [key]: max } }, []), {});
    assert.equal(applyLoopPatch(DEFAULT_LOOP_SETTINGS, { [key]: max })[key], max, key);
  }
  // A settings file from before the search settings keeps its values and gets the search defaults.
  const old = normalizeLoopSettings({ version: 1, maxFailedPlans: 5, iterationCap: 20, questionTimeoutSeconds: 60 }).settings;
  assert.deepEqual([old.maxFailedPlans, old.iterationCap, old.questionTimeoutSeconds, old.refuteWidth, old.constructMaxCandidates], [5, 20, 60, 1, 40]);
});

// ---------- pure search helpers ----------

test('search progress ignores other statements, ranks near-misses, and collects obstructions', () => {
  const candidates = [
    stamped('cand_a', candidate('main_theorem', 'failed', { H1: 'fail', H2: 'unknown', NOT: 'unknown' }), { round: 1, direction: 'small_cases' }),
    stamped('cand_b', candidate('main_theorem', 'failed', { H1: 'pass', H2: 'pass', NOT: 'fail' }), { round: 2, direction: 'extremal' }),
    stamped('cand_old', candidate(), { round: 1, statement_digest: 'old' }),
  ].map(search.parseCandidate);
  const rounds = [node('search_r1', matter.stringify(matter(roundRecord('main_theorem', 'Small cases are reflexive.')).content, { ...matter(roundRecord()).data, round: 1, statement_digest: 'd1', directions: ['small_cases', 'drop_hypothesis'] }), 'research/checks')].map(search.parseRound);
  const progress = search.searchProgress('main_theorem', 'd1', candidates, rounds);
  assert.equal(progress.lastRound, 2);
  assert.deepEqual(progress.candidates.map((item) => item.id), ['cand_a', 'cand_b']);
  assert.deepEqual(progress.nearMisses.map((item) => item.id), ['cand_b', 'cand_a']);
  assert.deepEqual(progress.obstructions, ['Small cases are reflexive.']);
  assert.deepEqual(progress.directionsTried.sort(), ['drop_hypothesis', 'extremal', 'small_cases']);
  const board = search.renderBoard(progress, { mode: 'refute', target: 'main_theorem', round: 3, obstructions: 12, nearMisses: 1 });
  assert.match(board, /cand_b \(extremal\): H1 ✓ H2 ✓ NOT ✗ — NOT fails/);
  assert.doesNotMatch(board, /cand_a/);
  assert.match(board, /Small cases are reflexive\./);
});

test('directions: test-case ideas first, untried catalog next, special directions from the configured round', () => {
  const refute = search.assignDirections({ mode: 'refute', round: 1, width: 3, tried: ['boundary_degenerate'], ideas: [{ id: 'idea_zero', title: 'Try zero' }], specialFromRound: 2 });
  assert.deepEqual(refute.map((slot) => [slot.slot, slot.direction]), [[1, 'idea_zero'], [2, 'small_cases'], [3, 'drop_hypothesis']]);
  const construct = search.assignDirections({ mode: 'construct', round: 2, width: 3, tried: ['adapt_known'], ideas: [], specialFromRound: 2, nearMiss: 'cand_best' });
  assert.deepEqual(construct.map((slot) => slot.direction), ['repair_near_miss', 'nonexistence', 'symmetric_algebraic']);
  assert.equal(construct[0].candidateId, 'cand_best');
  // Every direction tried: the catalog comes round again with a note to take a different route.
  const again = search.assignDirections({ mode: 'refute', round: 9, width: 2, tried: search.DIRECTIONS.map((item) => item.id), ideas: [], specialFromRound: 2 });
  assert.equal(again.length, 2);
  assert.match(again[0].label, /Tried before/);
});

test('candidate rules: verdicts must match the status, and only known verifiers are accepted', () => {
  const problems = (raw, options) => { const parsed = matter(raw); return search.candidateProblems('c', parsed.data, parsed.content, options); };
  assert.deepEqual(problems(candidate()), []);
  assert.deepEqual(problems(candidate('main_theorem', 'survived')), []);
  assert.match(problems(candidate('main_theorem', 'survived', { H1: 'pass', NOT: 'fail' })).join(), /must pass every check/);
  assert.match(problems(candidate().replace('## Failure', '## Notes')).join(), /needs a failing check and ## Failure/);
  assert.match(problems(candidate().replace('status: failed', 'status: archived')).join(), /status must be failed or survived/);
  assert.deepEqual(problems(candidate().replace('status: failed', 'status: archived'), { committed: true }), []);
  const coded = matter.stringify(matter(candidate()).content, { ...matter(candidate()).data, verifier: 'sage' });
  assert.match(problems(coded).join(), /unknown verifier sage/);
});

// ---------- the loop ----------

test('width 2: one pack per slot, one candidate set per slot, a summary, then the next round', async () => {
  const f = fixture({ refuteWidth: 2, refuteRounds: 2 });
  const next = await driveToSearch(f);
  assert.equal(next.stage, 'search');
  const round = f.core.current.current.search;
  assert.deepEqual([round.mode, round.round, round.slots.map((slot) => slot.direction)], ['refute', 1, ['boundary_degenerate', 'small_cases']]);
  assert.match(next.instruction, /Run 2 subagents in parallel, all in one message/);
  assert.match(next.instruction, /search-1\.md.*search-2\.md/);
  assert.match(f.map.get('.research-assistant-loop/context/search-2.md'), /Your slot: 2, round 1\. Direction small_cases/);
  assert.match(f.map.get('.research-assistant-loop/context/search-1.md'), /## Search board: refute search for main_theorem, round 1/);
  assert.equal(JSON.parse(f.map.get('.research-assistant-loop/context/current.json')).packs.length, 2);

  // A slot that was not assigned, and a third candidate beyond the per-worker limit, are refused.
  f.map.set('research/candidates/cand_main_theorem_r1_s3_x.md', candidate());
  await assert.rejects(f.core.report({ outcome: 'searched', summary: 'x' }), /slot 3 was not assigned/);
  f.map.delete('research/candidates/cand_main_theorem_r1_s3_x.md');
  for (const slug of ['a', 'b', 'c', 'd']) f.map.set(`research/candidates/cand_main_theorem_r1_s1_${slug}.md`, candidate());
  await assert.rejects(f.core.report({ outcome: 'searched', summary: 'x' }), /slot 1 wrote 4 candidates; at most 3/);
  for (const slug of ['b', 'c', 'd']) f.map.delete(`research/candidates/cand_main_theorem_r1_s1_${slug}.md`);
  f.map.set('research/candidates/cand_main_theorem_r1_s2_a.md', candidate());

  await f.core.report({ outcome: 'searched', summary: 'Two failed candidates' });
  assert.equal(f.core.current.stage, 'search_summary');
  const stampedCandidate = matter(f.map.get('research/candidates/cand_main_theorem_r1_s2_a.md')).data;
  assert.deepEqual([stampedCandidate.round, stampedCandidate.slot, stampedCandidate.direction, stampedCandidate.mode], [1, 2, 'small_cases', 'refute']);
  const summary = await f.core.next();
  assert.equal(summary.brief.worker, 'light');
  assert.match(f.map.get('.research-assistant-loop/context/current.md'), /cand_main_theorem_r1_s2_a \(small_cases\), failed: H1 ✓ NOT ✗/);
  f.map.set('research/checks/search_main_theorem_r1_sum.md', roundRecord('main_theorem', 'Reflexivity holds for every candidate.'));
  await f.core.report({ outcome: 'summarized', summary: 'Obstruction: reflexivity' });

  assert.equal(f.core.current.stage, 'search');
  const second = f.core.current.current.search;
  assert.equal(second.round, 2);
  assert.deepEqual(second.slots.map((slot) => slot.direction), ['drop_hypothesis', 'known_counterexamples']);
  await f.core.next();
  assert.match(f.map.get('.research-assistant-loop/context/search-1.md'), /Reflexivity holds for every candidate\./);
  writeRound(f, { record: false });
  await f.core.report({ outcome: 'searched', summary: 'Nothing again' });
  f.map.set('research/checks/search_main_theorem_r2_sum.md', roundRecord('main_theorem', 'Still reflexive.'));
  await f.core.report({ outcome: 'summarized', summary: 'Done' });
  assert.equal(f.core.current.stage, 'plan');
  const checkFile = [...f.map.keys()].find((file) => file.startsWith('research/checks/check_main_theorem_'));
  const check = matter(f.map.get(checkFile));
  assert.equal(check.data.outcome, 'no_counterexample_found');
  assert.match(check.content, /Round 2, drop_hypothesis: cand_main_theorem_r2_s1_/);
  assert.match(check.content, /Obstruction: Still reflexive\./);
  assert.match(check.content, /4 candidate\(s\) in 2 round\(s\)/);
});

test('a survivor rejected by independent verification stays as a near-miss and the search goes on', async () => {
  const f = fixture({ refuteRounds: 2 });
  await driveToSearch(f);
  writeRound(f, { status: 'survived' });
  await f.core.report({ outcome: 'searched', summary: 'A survivor' });
  assert.equal(f.core.current.stage, 'verify_counterexample');
  const { counterexampleId, search: round } = f.core.current.current;
  const exampleFile = `research/assets/${counterexampleId}.md`;
  f.map.set(exampleFile, f.map.get(exampleFile).replace('status: draft', 'status: archived') + '\n## Verdict\n\nrejected: 0 = 0 holds.\n');
  await f.core.report({ outcome: 'rejected', summary: 'Not a counterexample' });
  const archived = matter(f.map.get(`research/candidates/${round.candidateId}.md`));
  assert.equal(archived.data.status, 'archived');
  assert.match(archived.content, /Rejected by independent verification: rejected: 0 = 0 holds\./);
  assert.equal(f.core.current.stage, 'search');
  assert.equal(f.core.current.current.search.round, 2);
  await f.core.next();
  assert.match(f.map.get('.research-assistant-loop/context/search-1.md'), /rejected by independent verification/);
  await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');
});

test('search validation: names, targets, NOT check, round record, and no edits to existing files', async () => {
  const f = fixture();
  await driveToSearch(f);
  f.map.set('research/candidates/zero.md', candidate());
  f.map.set('research/checks/search_main_theorem_r1_x.md', roundRecord());
  await assert.rejects(f.core.report({ outcome: 'searched', summary: 'x' }), /must be named cand_main_theorem_r1_s<slot>_<slug>/);
  f.map.delete('research/candidates/zero.md');
  f.map.set('research/candidates/cand_main_theorem_r1_s1_a.md', candidate('main_theorem', 'failed', { H1: 'fail' }));
  await assert.rejects(f.core.report({ outcome: 'searched', summary: 'x' }), /needs the check NOT/);
  f.map.set('research/candidates/cand_main_theorem_r1_s1_a.md', candidate());
  f.map.set('research/assets/main_theorem.md', asset('For every natural number n, n + 0 = n.'));
  await assert.rejects(f.core.report({ outcome: 'searched', summary: 'x' }), /main_theorem\.md: not writable during stage search/);
  f.map.set('research/assets/main_theorem.md', asset());
  f.map.set('research/checks/check_main_theorem_mine.md', matter.stringify('\n## Cases checked\n\n- all\n\n## Limitations\n\nnone\n', { type: 'falsification_check', title: 'x', target_asset: 'main_theorem', outcome: 'no_counterexample_found' }));
  await assert.rejects(f.core.report({ outcome: 'searched', summary: 'x' }), /the loop writes falsification checks/);
  f.map.delete('research/checks/check_main_theorem_mine.md');
  await f.core.report({ outcome: 'searched', summary: 'x' });
  assert.equal(f.core.current.stage, 'plan');
});

test('a changed statement starts the search over; an old falsify stage re-selects to search; settings apply at once', async () => {
  const f = fixture();
  await driveToSearch(f);
  await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');
  // Statement changed by the researcher: old records no longer count, round 1 again.
  f.map.set('research/assets/main_theorem.md', asset('For every natural number n, n + 0 = n.'));
  await f.core.stop();
  await f.core.start('claude', { force: true });
  assert.equal(f.core.current.stage, 'search');
  assert.equal(f.core.current.current.search.round, 1);
  // A state saved by an older loop version at stage falsify.
  const state = JSON.parse(f.map.get('.research-assistant-loop/state.json'));
  f.map.set('.research-assistant-loop/state.json', JSON.stringify({ ...state, stage: 'falsify', current: { ...state.current, search: undefined } }));
  await f.core.load();
  // The researcher widened the search meanwhile; the next round uses it.
  f.map.set(SETTINGS, JSON.stringify({ version: 1, refuteWidth: 3 }));
  assert.equal((await f.core.next()).stage, 'search');
  assert.equal(f.core.current.current.search.slots.length, 3);
});

test('lowering the round limit below the rounds already recorded ends the search with a check', async () => {
  const f = fixture({ refuteRounds: 3 });
  await driveToSearch(f);
  await searchNothing(f);
  assert.equal(f.core.current.current.search.round, 2);
  f.map.set(SETTINGS, JSON.stringify({ version: 1, refuteRounds: 1 }));
  await f.core.stop();
  await f.core.start('claude', { force: true });
  assert.equal((await f.core.next()).stage, 'plan');
  assert.ok([...f.map.keys()].some((file) => file.startsWith('research/checks/check_main_theorem_')));
});

// ---------- construct mode ----------

test('a construction specification is approved before its search; auto mode may approve it when switched on', async () => {
  const f = fixture();
  const waiting = await driveToSearch(f, construction());
  assert.equal(waiting.stage, 'waiting');
  assert.match(waiting.instruction, /specification main_theorem/);
  const next = await approveSpecification(f);
  assert.equal(next.stage, 'search');
  assert.deepEqual([f.core.current.current.search.mode, f.core.current.current.search.properties], ['construct', ['P1', 'P2']]);
  assert.ok(f.map.has('research/approvals/specifications/main_theorem.json'));
  assert.equal(matter(f.map.get('research/assets/main_theorem.md')).data.status, 'draft');

  const autoMode = fixture({ autoApprove: { enabled: true, specifications: true } });
  assert.equal((await driveToSearch(autoMode, construction())).stage, 'search');
  const manual = fixture({ autoApprove: { enabled: true } });
  assert.equal((await driveToSearch(manual, construction())).stage, 'waiting');
});

test('a construction of a given object, without a property list, is falsified and proved as before', async () => {
  const f = fixture();
  const next = await driveToSearch(f, construction('Let G be the symmetric group S3.'));
  assert.equal(next.stage, 'search');
  assert.equal(f.core.current.current.search.mode, 'refute');
});

test('construct search: checks are the specification properties; a verified survivor becomes the construction and its proof', async () => {
  const f = fixture({ constructWidth: 2 });
  await driveToSearch(f, construction());
  const next = await approveSpecification(f);
  assert.match(next.instruction, /Run 2 subagents in parallel/);
  assert.match(next.instruction, /checks \{P1, P2 \(every property of the specification\)/);
  assert.match(f.map.get('.research-assistant-loop/context/search-1.md'), /Find an object with every property of the specification of main_theorem \(checks P1, P2\)/);
  f.map.set(`research/candidates/cand_main_theorem_r1_s1_bad.md`, groupCandidate('failed', { P1: 'pass', NOT: 'fail' }));
  await assert.rejects(f.core.report({ outcome: 'searched', summary: 'x' }), /checks must be exactly the specification's properties P1, P2; missing P2; unknown NOT/);
  f.map.delete(`research/candidates/cand_main_theorem_r1_s1_bad.md`);
  writeConstructRound(f, { survivor: true });
  await f.core.report({ outcome: 'searched', summary: 'S3 survives' });
  assert.equal(f.core.current.stage, 'verify_construction');
  const candidateId = f.core.current.current.search.candidateId;
  const verify = await f.core.next();
  assert.equal(verify.brief.worker, 'deep');
  const pack = f.map.get('.research-assistant-loop/context/current.md');
  assert.match(pack, /The symmetric group S3\./);
  assert.doesNotMatch(pack, /\(12\)\(13\) differs/);
  const file = `research/candidates/${candidateId}.md`;
  f.map.set(file, f.map.get(file) + '\n## Verdict\n\nconfirmed\n\n### P1\n\nS3 has 6 elements.\n');
  await assert.rejects(f.core.report({ outcome: 'confirmed', summary: 'x' }), /needs a ### section with the argument for P2/);
  f.map.set(file, f.map.get(file) + '\n### P2\n\n(12)(13) = (132) but (13)(12) = (123).\n');
  const before = f.map.get('research/assets/main_theorem.md');
  await f.core.report({ outcome: 'confirmed', summary: 'Verified' });
  const after = f.map.get('research/assets/main_theorem.md');
  assert.match(after, /## Construction\n\nThe symmetric group S3\.\n\n## Proof\n\n### P1\n\nS3 has 6 elements\.[\s\S]*### P2/);
  const { statementDigest } = load('../src/services/ResearchLoopModel.ts');
  assert.equal(statementDigest(after), statementDigest(before));
  // The specification approval still holds; the asset now waits for approval as a proved result.
  assert.equal((await f.core.next()).stage, 'waiting');
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'asset' && item.target === 'main_theorem'));
  assert.ok(!f.core.current.approvalQueue.some((item) => item.kind === 'specification'));
});

test('a rejected construction stays as a near-miss for the repair direction', async () => {
  const f = fixture({ constructWidth: 1, constructRounds: 3, specialDirectionsFromRound: 2 });
  await driveToSearch(f, construction());
  await approveSpecification(f);
  writeConstructRound(f, { survivor: true });
  await f.core.report({ outcome: 'searched', summary: 'S3 survives' });
  const file = `research/candidates/${f.core.current.current.search.candidateId}.md`;
  f.map.set(file, f.map.get(file) + '\n## Verdict\n\nrejected: the check of P2 used the wrong product.\n');
  await f.core.report({ outcome: 'rejected', summary: 'Not verified' });
  assert.equal(matter(f.map.get(file)).data.status, 'archived');
  assert.equal(f.core.current.stage, 'search');
  const round = f.core.current.current.search;
  assert.equal(round.round, 2);
  assert.deepEqual(round.slots.map((slot) => slot.direction), ['repair_near_miss']);
  await f.core.next();
  assert.match(f.map.get('.research-assistant-loop/context/search-1.md'), /### candidate cand_main_theorem_r1_s1_g\d+ — research\/candidates\/[\s\S]*The symmetric group S3/);
});

test('construct limits ask the researcher; a direction resets them, silence parks the asset', async () => {
  const f = fixture({ constructWidth: 1, constructRounds: 1 });
  await driveToSearch(f, construction());
  await approveSpecification(f);
  writeConstructRound(f);
  const result = await f.core.report({ outcome: 'searched', summary: 'Nothing' });
  assert.match(result.message, /construction search for main_theorem is exhausted/);
  const question = f.core.current.pendingQuestion;
  assert.equal(question.kind, 'blocked');
  assert.match(question.prompt, /used 1 round\(s\) and 1 candidate\(s\) since the last direction/);
  await f.core.answerQuestion(question.id, 'answer', 'Try permutation groups.', 'popup');
  const next = await f.core.next();
  assert.equal(next.stage, 'search');
  assert.equal(f.core.current.current.search.round, 2);
  assert.match(f.map.get('.research-assistant-loop/context/search-1.md'), /Latest researcher direction: Try permutation groups\./);
  writeConstructRound(f);
  await f.core.report({ outcome: 'searched', summary: 'Nothing again' });
  await f.core.answerQuestion(f.core.current.pendingQuestion.id, 'skip', '', 'timeout');
  assert.equal(f.core.current.parked.main_theorem.reason, 'search_exhausted');

  // The candidate limit stops a search before the round limit does.
  const capped = fixture({ constructWidth: 2, constructRounds: 5, constructMaxCandidates: 2 });
  await driveToSearch(capped, construction());
  await approveSpecification(capped);
  writeConstructRound(capped);
  await capped.core.report({ outcome: 'searched', summary: 'Two candidates' });
  capped.map.set('research/checks/search_main_theorem_r1_sum.md', roundRecord());
  await capped.core.report({ outcome: 'summarized', summary: 'Summary' });
  assert.match(capped.core.current.pendingQuestion.prompt, /2 candidate\(s\)/);
});

// ---------- researcher-requested search ----------

test('a researcher-requested search reopens a checked asset, shows failed proofs, and ends with a new check', async () => {
  const f = fixture({ requestedSearchRounds: 1 });
  await driveToSearch(f);
  await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');
  f.map.set('research/plans/attempt_1.md', matter.stringify('\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\n## Plan\n\n1. [ ] Induct.\n\n## Verification\n\nDone.\n\n## Failure\n\nINDUCTION BREAKS AT n = 7.\n', { type: 'plan', title: 'attempt_1', status: 'failed', target_asset: 'main_theorem', inspired_by: [], tags: [] }));
  await assert.rejects(f.core.requestSearch('main_theorem', 99), /--rounds must be a whole number from 1 to 10/);
  const message = await f.core.requestSearch('main_theorem');
  assert.match(message, /Requested 1 more round\(s\)/);
  assert.ok([...f.map.keys()].some((file) => /research\/decisions\/decision_.*_search_request_main_theorem_/.test(file)));
  assert.equal(f.core.current.stage, 'select');
  assert.equal((await f.core.next()).stage, 'search');
  const round = f.core.current.current.search;
  assert.deepEqual([round.round, round.requested, round.slots[0].direction], [2, true, 'small_cases']);
  const pack = f.map.get('.research-assistant-loop/context/search-1.md');
  assert.match(pack, /INDUCTION BREAKS AT n = 7/);
  assert.match(pack, /The researcher asked for this deeper search/);
  await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');
  assert.equal([...f.map.keys()].filter((file) => file.startsWith('research/checks/check_main_theorem_')).length, 2);
  // The request is used up: the next selection plans again.
  await f.core.stop();
  await f.core.start('claude', { force: true });
  assert.equal((await f.core.next()).stage, 'plan');
  // A construction search is redirected, not re-requested.
  const c = fixture();
  await driveToSearch(c, construction());
  await assert.rejects(c.core.requestSearch('main_theorem'), /give it a new direction instead/);
});
