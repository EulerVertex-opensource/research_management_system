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
const { Teaching } = load('../src/services/Teaching.ts');
const { markFor, studyItems, understandingState, UNDERSTANDING_PATH } = load('../src/domain/understanding.ts');
const { TEACH_PROMPT_PATTERN, teachPrompt } = load('../src/domain/understandingLevels.ts');
const { parseSessionRoles, preToolUseDecision, roleSignal, sessionRole, teachingToolDecision, withSessionRole } = load('../src/services/ResearchLoopHooks.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const node = (title, type, statement, extra = {}) => matter.stringify(`\n## Statement\n\n${statement}\n`, { type, title, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });
const planFor = (target, id) => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\nProve it.\n\n## Plan\n\n1. [ ] Use reflexivity.\n\n## Verification\n\nCheck the equality.\n`, { type: 'plan', title: id, status: 'pending', target_asset: target, inspired_by: [], tags: [] });

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
  const files = memoryFiles({ 'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n', '.research-assistant-loop/settings.json': JSON.stringify({ version: 1, rigor: { verifyProofs: 'agent', refuteSearch: 'off' }, ...settings }) });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map, teaching: new Teaching(files, paths) };
}

/** Goals approved; the key lemma and the main theorem resting on it scaffolded; the key lemma proved and its proof confirmed by the independent check. */
async function lemmaChecked(f) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'project');
  // Working on its own, the goals are approved without the researcher.
  if (request) await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/key_lemma.md', node('Key lemma', 'lemma', 'Every n satisfies n = n.'));
  f.map.set('research/assets/main_theorem.md', node('Main theorem', 'theorem', 'A holds.', { depends_on: ['key_lemma'] }));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'plan');
  assert.equal(f.core.current.current.assetId, 'key_lemma');
  f.map.set('research/plans/lemma_plan.md', planFor('key_lemma', 'lemma_plan'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'lemma_plan' });
  f.map.set('research/assets/key_lemma.md', f.map.get('research/assets/key_lemma.md') + '\n## Proof\n\nEquality is reflexive.\n');
  const plan = matter(f.map.get('research/plans/lemma_plan.md'));
  f.map.set('research/plans/lemma_plan.md', matter.stringify(plan.content + '\n## Outcome\n\nDone.\n', { ...plan.data, status: 'succeeded' }));
  assert.equal((await f.core.report({ outcome: 'proved', summary: 'Proved the key lemma by reflexivity.' })).stage, 'verify_proof');
  f.map.set('research/plans/lemma_plan.md', f.map.get('research/plans/lemma_plan.md').trimEnd() + '\n\n## Verdict\n\nconfirmed\n\nOne line.\n');
  await f.core.report({ outcome: 'confirmed', summary: 'The key lemma holds.' });
  return f.core.next();
}

test('a mark goes stale with the statement; a proof change keeps only what it says', () => {
  const raw = node('Key lemma', 'lemma', 'Every n satisfies n = n.') + '\n## Proof\n\nReflexivity.\n';
  const idea = markFor(raw, 'idea', '2026-10-28T00:00:00Z', 'reflexivity');
  assert.deepEqual(understandingState(idea, raw), { state: 'understood', level: 'idea' });
  assert.deepEqual(understandingState(idea, raw.replace('Reflexivity.', 'By symmetry.')), { state: 'proof_changed', level: 'black_box' });
  assert.deepEqual(understandingState(markFor(raw, 'black_box', 'now'), raw.replace('Reflexivity.', 'By symmetry.')), { state: 'understood', level: 'black_box' });
  assert.deepEqual(understandingState(idea, raw.replace('n = n', 'n \\le n')), { state: 'statement_changed' });
  // A frontmatter-only change (a tag, a dependency link) is not a new statement to study.
  assert.deepEqual(understandingState(idea, raw.replace('tags: []', 'tags: [algebra]')), { state: 'understood', level: 'idea' });
  assert.equal(idea.snapshot.proof, 'Reflexivity.');
});

test('study items come after what they rest on, and aim for the key idea of main and hard-won results', () => {
  const lemma = node('Key lemma', 'lemma', 'L.') + '\n## Proof\n\nP.\n';
  const main = node('Main theorem', 'theorem', 'T.') + '\n## Proof\n\nQ.\n';
  const items = studyItems([
    { id: 'main_theorem', kind: 'asset', type: 'theorem', title: 'Main theorem', raw: main, verified: 'approved', prerequisites: ['key_lemma', 'compactness'], required: true, failedPlans: 0 },
    { id: 'key_lemma', kind: 'asset', type: 'lemma', title: 'Key lemma', raw: lemma, verified: 'checked', prerequisites: [], required: false, failedPlans: 0 },
  ], {});
  assert.deepEqual(items.map((item) => item.id), ['key_lemma', 'main_theorem']);
  assert.equal(items[0].suggested, 'black_box');
  assert.equal(items[1].suggested, 'idea');
  assert.deepEqual(items[1].waitingOn, ['key_lemma'], 'an unverified prerequisite is not something to study first');
  const marked = studyItems([{ id: 'key_lemma', kind: 'asset', type: 'lemma', title: 'Key lemma', raw: lemma, verified: 'checked', prerequisites: [], required: false, failedPlans: 2 }], { key_lemma: markFor(lemma, 'black_box', 'now') });
  assert.equal(marked[0].state, 'understood');
  assert.equal(marked[0].suggested, 'idea');
});

test('only verified results are taught; a confirmed proof counts before the researcher approves it', async () => {
  const f = fixture();
  assert.match(await f.teaching.listText(), /No verified results yet/);
  await lemmaChecked(f);
  const { items, behind } = await f.teaching.overview();
  assert.deepEqual(items.map((item) => [item.id, item.verified, item.state]), [['key_lemma', 'checked', 'new']]);
  assert.equal(behind, 1);
  const list = await f.teaching.listText();
  assert.match(list, /\[New to you\] Key lemma \(key_lemma\)/);
  assert.match(list, /The loop said: Proved the key lemma by reflexivity\./);
  assert.match(list, /Link: \[Key lemma\]\(\.research-assistant-loop\/open\/key_lemma\.md\) \(file: \[research\/assets\/key_lemma\.md\]\(research\/assets\/key_lemma\.md\)\)/);
  // Every link in the text opens: its link file names the node and its file.
  assert.match(f.map.get('.research-assistant-loop/open/key_lemma.md'), /^# Key lemma\n[\s\S]*research\/assets\/key_lemma\.md/);
  await assert.rejects(f.teaching.packText('main_theorem'), /not verified yet/);
  await assert.rejects(f.teaching.mark('main_theorem', 'idea', { at: 'now' }), /not a verified result/);
});

test('the teaching pack carries the proof, how it was found, what the researcher knows, and their doubts', async () => {
  const f = fixture();
  await lemmaChecked(f);
  const id = await f.core.saveIdea('Is step 1 circular?', 'I do not see why reflexivity applies here.', ['key_lemma'], 'researcher', [], 'risk');
  const pack = await f.teaching.packText('key_lemma');
  assert.match(pack, /# Teaching material: Key lemma \(key_lemma\)/);
  assert.match(pack, /\n## Statement\n\nEvery n satisfies n = n\.\n/);
  assert.match(pack, /## Proof\n\nEquality is reflexive\./);
  assert.match(pack, /It holds up: Main theorem\./);
  assert.match(pack, /## How this proof was found \(plan lemma_plan\)[\s\S]*#### Verdict\n\nconfirmed/);
  assert.match(pack, new RegExp(`Is step 1 circular\\? \\(${id}, risk, raised by the researcher\\)`));
  assert.match(pack, /The researcher: new to you\. Suggested aim: what it says\./);
  const links = pack.slice(pack.indexOf('## Links for the researcher'));
  assert.match(links, /- \[Key lemma\]\(\.research-assistant-loop\/open\/key_lemma\.md\)/);
  assert.match(links, /- \[Main theorem\]\(\.research-assistant-loop\/open\/main_theorem\.md\) \(file: \[research\/assets\/main_theorem\.md\]/, 'what it holds up');
  assert.match(links, /- \[lemma_plan \(succeeded plan\)\]\(\.research-assistant-loop\/open\/lemma_plan\.md\) \(file: \[research\/plans\/lemma_plan\.md\]/);
  assert.match(links, new RegExp(`open/${id}\\.md\\) \\(file: \\[research/ideas/${id}\\.md\\]`));
  for (const node of ['key_lemma', 'main_theorem', 'lemma_plan', id]) assert.ok(f.map.has(`.research-assistant-loop/open/${node}.md`), node);
  assert.doesNotMatch(pack, /vscode:/);
});

test('a mark is the researcher\'s, kept locally, and a changed proof is taught from what changed', async () => {
  const f = fixture();
  await lemmaChecked(f);
  const item = await f.teaching.mark('key_lemma', 'idea', { at: '2026-10-28T10:00:00Z', note: 'just reflexivity' });
  assert.equal(item.state, 'understood');
  assert.ok(f.map.has(UNDERSTANDING_PATH));
  assert.match(await f.teaching.listText(), /Already understood:\n- Key lemma \(key_lemma\): the key idea; your note: just reflexivity/);
  // The loop rewrites the proof (and the check confirms it again): the researcher's idea-level mark no longer holds.
  const file = 'research/assets/key_lemma.md';
  f.map.set(file, f.map.get(file).replace('Equality is reflexive.', 'Equality is reflexive, by definition of equality.'));
  const plan = matter(f.map.get('research/plans/lemma_plan.md'));
  const { proofDigest } = load('../src/domain/digests.ts');
  const digest = proofDigest(f.map.get(file));
  f.map.set('research/plans/lemma_plan.md', matter.stringify(plan.content, { ...plan.data, proof_digest: digest, verified_proof_digest: digest }));
  const { items } = await f.teaching.overview();
  assert.equal(items[0].state, 'proof_changed');
  assert.equal(items[0].level, 'black_box');
  const pack = await f.teaching.packText('key_lemma');
  assert.match(pack, /## The proof the researcher studied \(2026-10-28\)\n\nEquality is reflexive\.\n/);
  await f.teaching.mark('key_lemma', 'none', { at: 'now' });
  assert.equal((await f.teaching.overview()).items[0].state, 'new');
});

test('with a limit set, the loop waits for the researcher to catch up before starting new proofs', async () => {
  const f = fixture({ studyAhead: 1 });
  const result = await lemmaChecked(f);
  assert.equal(result.stage, 'waiting');
  assert.deepEqual(f.core.current.waitingOn, [{ kind: 'study', target: '1', detail: '1' }]);
  await f.teaching.mark('key_lemma', 'black_box', { at: 'now' });
  const next = await f.core.next();
  assert.equal(next.stage, 'plan');
  assert.equal(f.core.current.current.assetId, 'main_theorem');
});

test('by default, and while working on its own, the loop never waits for the researcher to study', async () => {
  const plain = fixture();
  assert.equal((await lemmaChecked(plain)).stage, 'plan');
  const alone = fixture({ studyAhead: 1, autonomy: { enabled: true } });
  assert.notEqual((await lemmaChecked(alone)).stage, 'waiting');
});

test('a chat that names the teach skill is a teaching chat; one that has driven the loop never becomes one', () => {
  assert.equal(roleSignal('UserPromptSubmit', { prompt: '/teach' }, TEACH_PROMPT_PATTERN), 'teach');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: '$teach key_lemma' }, TEACH_PROMPT_PATTERN), 'teach');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: teachPrompt({ id: 'key_lemma', title: 'Key lemma' }) }, TEACH_PROMPT_PATTERN), 'teach');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: 'continue the loop and teach me nothing' }, TEACH_PROMPT_PATTERN), undefined);
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  assert.equal(roleSignal('PreToolUse', bash('node .claude/skills/research-loop/scripts/research-loop.cjs next'), TEACH_PROMPT_PATTERN), 'drive');
  assert.equal(roleSignal('PreToolUse', bash('node .agents/skills/research-loop/scripts/research-loop.cjs teach list'), TEACH_PROMPT_PATTERN), 'teach');
  let roles = parseSessionRoles('');
  roles = withSessionRole(roles, 'drive', 's1', 'now');
  roles = withSessionRole(roles, 'teach', 's2', 'now');
  assert.equal(sessionRole(roles, 's1'), 'drive');
  assert.equal(sessionRole(withSessionRole(roles, 'teach', 's1', 'later'), 's1'), 'drive');
  assert.equal(sessionRole(parseSessionRoles(JSON.stringify(roles)), 's2'), 'teach');
});

test('a teaching chat may read and record doubts, but not drive the loop or edit the project', () => {
  const root = '/work/project';
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const loop = 'node .agents/skills/research-loop/scripts/research-loop.cjs';
  for (const command of ['teach list', 'teach pack key_lemma', 'status --brief', 'show key_lemma --section Proof', 'search status key_lemma', 'idea add --title t --body b', 'library search compactness']) {
    assert.equal(teachingToolDecision(paths, bash(`${loop} ${command}`), root).deny, false, command);
  }
  for (const command of ['next', 'report proved --summary x', 'resume', 'park key_lemma --reason x', 'search request key_lemma', 'idea convert idea_1 --asset a', 'sync pull']) {
    assert.match(teachingToolDecision(paths, bash(`${loop} ${command}`), root).reason ?? '', /teaching chat/, command);
  }
  assert.equal(teachingToolDecision(paths, { tool_name: 'Edit', tool_input: { file_path: `${root}/research/assets/key_lemma.md` } }, root).deny, true);
  assert.equal(teachingToolDecision(paths, { tool_name: 'Write', tool_input: { file_path: '/tmp/scratch/notes.md' } }, root).deny, false);
});

test('no agent writes what the researcher understood', () => {
  const root = '/work/project';
  assert.match(preToolUseDecision(paths, { tool_name: 'Write', tool_input: { file_path: `${root}/research-local/understanding.json`, content: '{}' } }, root).reason ?? '', /only the researcher sets it/);
  assert.equal(preToolUseDecision(paths, { tool_name: 'Bash', tool_input: { command: 'echo {} > research-local/understanding.json' } }, root).deny, true);
  assert.equal(preToolUseDecision(paths, { tool_name: 'Bash', tool_input: { command: 'cat research-local/understanding.json' } }, root).deny, false);
});

// ---------- rewording from the teaching chat ----------

const { parseRevisionDraft, withProof, withRemarks, remarksOf } = load('../src/domain/revisions.ts');
const { researchDigest, proofDigest: digestOfProof, statementDigest: digestOfStatement } = load('../src/domain/digests.ts');
const { layoutProblem } = load('../src/domain/layout.ts');
const REWORDED = '## Proof\n\nBy reflexivity of equality, $n = n$ for every $n$.\n\n## Changes\n\nOne sentence instead of a bare citation.\n';
const LEMMA = 'research/assets/key_lemma.md';
const verdictFor = (f, planId, verdict) => f.map.set(`research/plans/${planId}.md`, f.map.get(`research/plans/${planId}.md`).trimEnd() + `\n\n## Verdict\n\n${verdict}\n`);

test('a rewording draft holds only the proof, its changes, and remarks; remarks change no digest', () => {
  assert.deepEqual(parseRevisionDraft(REWORDED), { proof: 'By reflexivity of equality, $n = n$ for every $n$.', changes: 'One sentence instead of a bare citation.' });
  assert.deepEqual(parseRevisionDraft('## Remarks\n\nThink of it as a mirror.\n'), { remarks: 'Think of it as a mirror.' });
  assert.deepEqual(parseRevisionDraft('## Remarks\n'), { remarks: '' });
  assert.throws(() => parseRevisionDraft('## Proof\n\nNew.\n'), /needs ## Changes/);
  assert.throws(() => parseRevisionDraft('## Statement\n\nStronger.\n\n' + REWORDED), /never changes the statement/);
  assert.throws(() => parseRevisionDraft('Every n is even.\n\n' + REWORDED), /never changes the statement/);
  const raw = node('Key lemma', 'lemma', 'Every n satisfies n = n.') + '\n## Proof\n\nEquality is reflexive.\n';
  const { content, data } = matter(raw);
  const remarked = matter.stringify(withRemarks(content, 'Think of it as a mirror.'), data);
  assert.equal(remarksOf(matter(remarked).content), 'Think of it as a mirror.');
  assert.equal(researchDigest(remarked, 'asset'), researchDigest(raw, 'asset'), 'approval stands');
  assert.equal(digestOfProof(remarked), digestOfProof(raw), 'verification stands');
  const reworded = matter.stringify(withProof(matter(remarked).content, 'A new proof.'), data);
  assert.match(reworded, /## Proof\n\nA new proof\.\n/);
  assert.equal(remarksOf(matter(reworded).content), 'Think of it as a mirror.', 'remarks survive a new proof');
  assert.equal(digestOfStatement(reworded), digestOfStatement(raw));
  assert.equal(layoutProblem(paths, 'research/style.md'), undefined);
});

test('a rewording waits for the loop to be between stages', async () => {
  const f = fixture();
  await lemmaChecked(f);
  await f.teaching.propose('key_lemma', REWORDED, 'now');
  assert.match(await f.teaching.listText(), /Rewordings waiting for the loop to check and apply: Key lemma \(proof\)/);
  assert.match(await f.teaching.packText('key_lemma'), /## A rewording waiting for the loop[\s\S]*By reflexivity of equality/);
  assert.equal((await f.core.next()).stage, 'plan', 'mid-stage, nothing changes');
  assert.match(f.map.get(LEMMA), /Equality is reflexive\./);
  await assert.rejects(f.teaching.propose('main_theorem', REWORDED, 'now'), /not a verified result/);
});

/** The key lemma proved and accepted by the researcher, who checks proofs themselves (so no independent check ran); the loop is between stages. */
async function lemmaApproved(f) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.kind === 'project').id, 'approved', '', 'test');
  await f.core.next();
  f.map.set(LEMMA, node('Key lemma', 'lemma', 'Every n satisfies n = n.'));
  f.map.set('research/assets/main_theorem.md', node('Main theorem', 'theorem', 'A holds.', { depends_on: ['key_lemma'] }));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  await f.core.next();
  f.map.set('research/plans/lemma_plan.md', planFor('key_lemma', 'lemma_plan'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'lemma_plan' });
  f.map.set(LEMMA, f.map.get(LEMMA) + '\n## Proof\n\nEquality is reflexive.\n');
  const plan = matter(f.map.get('research/plans/lemma_plan.md'));
  f.map.set('research/plans/lemma_plan.md', matter.stringify(plan.content + '\n## Outcome\n\nDone.\n', { ...plan.data, status: 'succeeded' }));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.target === 'key_lemma').id, 'approved', '', 'test');
  assert.equal(matter(f.map.get(LEMMA)).data.status, 'approved');
  assert.equal(f.core.current.stage, 'select');
}
const researcherChecks = () => fixture({ rigor: { verifyProofs: 'researcher', refuteSearch: 'off' } });

test('a reworded proof is always checked independently first; confirmed, it goes back to the researcher and keeps their mark', async () => {
  const f = researcherChecks();
  await lemmaApproved(f);
  await f.teaching.mark('key_lemma', 'idea', { at: '2026-10-28T10:00:00Z', note: 'reflexivity' });
  await f.teaching.propose('key_lemma', REWORDED + '\n## Remarks\n\nThink of it as a mirror.\n', 'now');
  const next = await f.core.next();
  assert.equal(next.stage, 'verify_proof', 'checked even though the researcher checks proofs themselves');
  assert.equal(f.core.current.current.planId, 'key_lemma_rewording');
  const asset = matter(f.map.get(LEMMA));
  assert.equal(asset.data.status, 'draft', 'the new wording is not what was approved');
  assert.match(asset.content, /## Proof\n\nBy reflexivity of equality/);
  const rewrite = matter(f.map.get('research/plans/key_lemma_rewording.md'));
  assert.equal(rewrite.data.purpose, 'rewrite');
  assert.match(rewrite.content, /## Previous proof\n\nEquality is reflexive\./);
  assert.match(rewrite.content, /## Changes\n\nOne sentence instead of a bare citation\./);
  const pack = (await f.core.contextPack()).text;
  assert.match(pack, /By reflexivity of equality/);
  assert.doesNotMatch(pack, /Previous proof|bare citation/, 'the verifier judges the proof as written');
  verdictFor(f, 'key_lemma_rewording', 'confirmed\n\nSame argument.');
  const result = await f.core.report({ outcome: 'confirmed', summary: 'The reworded proof holds.' });
  assert.match(result.message, /verified independently/);
  assert.equal(f.core.current.approvalQueue.find((item) => item.target === 'key_lemma').reason, 'Proof reworded at your request in the teaching chat, verified independently.');
  assert.equal(remarksOf(matter(f.map.get(LEMMA)).content), 'Think of it as a mirror.', 'remarks come with a confirmed rewording');
  const item = (await f.teaching.overview()).items.find((entry) => entry.id === 'key_lemma');
  assert.deepEqual([item.state, item.level, item.note], ['understood', 'idea', 'reflexivity']);
});

test('a rejected rewording brings the previous proof back, approved, and counts as no failed attempt', async () => {
  const f = researcherChecks();
  await lemmaApproved(f);
  await f.teaching.propose('key_lemma', REWORDED, 'now');
  assert.equal((await f.core.next()).stage, 'verify_proof');
  verdictFor(f, 'key_lemma_rewording', 'rejected\n\nThe new sentence drops the case n = 0.');
  const result = await f.core.report({ outcome: 'rejected', summary: 'The rewording drops a case.' });
  assert.match(result.message, /previous proof is back and still approved/);
  const asset = matter(f.map.get(LEMMA));
  assert.equal(asset.data.status, 'approved');
  assert.match(asset.content, /## Proof\n\nEquality is reflexive\./);
  const rewrite = matter(f.map.get('research/plans/key_lemma_rewording.md'));
  assert.equal(rewrite.data.status, 'abandoned');
  assert.match(rewrite.content, /## Failure/);
  assert.deepEqual((await f.core.validateWorkspace()).problems, []);
  assert.equal((await f.teaching.overview()).items.find((entry) => entry.id === 'key_lemma').failedPlans, 0);
});

test('remarks are added between stages without touching the approval; a proposal against an older version is dropped', async () => {
  const f = researcherChecks();
  await lemmaApproved(f);
  await f.teaching.propose('key_lemma', '## Remarks\n\nThink of it as a mirror.\n', 'now');
  await f.core.next();
  assert.notEqual(f.core.current.stage, 'verify_proof');
  assert.equal(remarksOf(matter(f.map.get(LEMMA)).content), 'Think of it as a mirror.');
  assert.equal(matter(f.map.get(LEMMA)).data.status, 'approved');
  assert.deepEqual((await f.core.validateWorkspace()).problems, []);
  assert.match(await f.teaching.packText('key_lemma'), /## The researcher's remarks \(not part of the proof\)\n\nThink of it as a mirror\./);

  const g = researcherChecks();
  await lemmaApproved(g);
  await g.teaching.propose('key_lemma', REWORDED, 'now');
  g.map.set(LEMMA, g.map.get(LEMMA).replace('Equality is reflexive.', 'Equality is reflexive, always.'));
  assert.notEqual((await g.core.next()).stage, 'verify_proof');
  assert.match(g.map.get(LEMMA), /reflexive, always/);
  assert.ok((await g.core.recentEvents(20)).some((event) => event.type === 'revision_discarded'));
  assert.deepEqual(await g.teaching.pendingRevisions(), []);
});

test('the project proof style is kept for everyone and given to the proof writer', async () => {
  const f = fixture();
  await f.teaching.addStyle('Use "we" throughout.');
  await f.teaching.addStyle('Never write "clearly".');
  assert.match(f.map.get('research/style.md'), /^# Proof style\n[\s\S]*- Use "we" throughout\.\n- Never write "clearly"\.\n$/);
  assert.match(await f.teaching.styleText(), /^How proofs in this project are written/);
  await lemmaChecked(f);
  f.map.set('research/plans/main_plan.md', planFor('main_theorem', 'main_plan'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'main_plan' });
  assert.equal((await f.core.next()).stage, 'execute');
  assert.match((await f.core.contextPack()).text, /Never write "clearly"\./);
});

test('each node has a link file naming it, rewritten only when its title or file changes', async () => {
  const { writeDashboardLinks, dashboardLinkPath } = load('../src/services/ResearchLoopModel.ts');
  const files = memoryFiles();
  const nodes = [{ id: 'key_lemma', title: 'Key lemma', file: 'research/assets/key_lemma.md' }, { id: 'p1', title: 'A plan', file: 'research/plans/p1.md' }];
  assert.equal(await writeDashboardLinks(files, nodes), 2);
  assert.equal(dashboardLinkPath('key_lemma'), '.research-assistant-loop/open/key_lemma.md');
  assert.equal(await writeDashboardLinks(files, nodes), 0);
  assert.equal(await writeDashboardLinks(files, [{ ...nodes[0], title: 'The key lemma' }]), 1);
  assert.match(files.map.get('.research-assistant-loop/open/key_lemma.md'), /^# The key lemma\n/);
});
