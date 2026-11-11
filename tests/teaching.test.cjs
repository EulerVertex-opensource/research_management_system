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
const { loopRemarkDecision, nextSessionRole, parseSessionRoles, preToolUseDecision, roleSignal, sessionRole, teachingToolDecision, withSessionRole, writingToolDecision } = load('../src/services/ResearchLoopHooks.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', remarks: 'research/remarks', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
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
  const files = memoryFiles({ 'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n', '.research-assistant-loop/settings.json': JSON.stringify({ version: 1, routeWidth: 0, rigor: { verifyProofs: 'agent', refuteSearch: 'off' }, ...settings }) });
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
  // An approach a plan used stays among the doubts; a refuted observation shows as a dead end with its reason.
  const used = await f.core.saveIdea('Try symmetry', 'Swap the sides.', ['key_lemma'], 'agent', [], 'approach');
  await f.core.convertIdea(used, 'key_lemma', 'By symmetry', 'Swap', 'Check');
  const wrong = await f.core.saveIdea('Every relation is symmetric', 'Looks so.', ['key_lemma'], 'agent', [], 'observation');
  await f.core.markIdea(wrong, 'refuted', 'The order relation < is not symmetric.');
  const later = await f.teaching.packText('key_lemma');
  assert.match(later, new RegExp(`## Open doubts and questions about it\\n\\n[^#]*Try symmetry \\(${used}, approach, raised by the agent\\)`));
  assert.match(later, new RegExp(`## Known dead ends near it \\(refuted observations, obstructed approaches\\)\\n\\n- Every relation is symmetric \\(${wrong}, observation, refuted, raised by the agent\\): The order relation < is not symmetric\\.`));
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

test('remarks: the teaching chat writes them from teaching and says whose; the loop never poses as it, and a checking stage reads none', () => {
  const root = '/work/project';
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const loop = 'node .agents/skills/research-loop/scripts/research-loop.cjs';
  for (const command of ['remark add --target key_lemma --title t --body b --origin researcher --from teaching', 'remark edit remark_1 --body b --from teaching', 'remark archive remark_1 --from teaching', 'remark list --target key_lemma']) {
    assert.equal(teachingToolDecision(paths, bash(`${loop} ${command}`), root).deny, false, command);
  }
  for (const command of ['remark add --target key_lemma --title t --body b --from teaching', 'remark add --target key_lemma --title t --body b --origin agent --from loop', 'remark add --target key_lemma --title t --body b --origin agent', 'remark archive remark_1 --from loop']) {
    assert.match(teachingToolDecision(paths, bash(`${loop} ${command}`), root).reason ?? '', /from teaching/, command);
  }
  for (const tool of ['mcp__research-assistant__add_remark', 'mcp__research_assistant__add_remark']) {
    assert.equal(teachingToolDecision(paths, { tool_name: tool, tool_input: { target: 'key_lemma', title: 't', body: 'b', origin: 'researcher', from: 'teaching' } }, root).deny, false, tool);
    assert.equal(teachingToolDecision(paths, { tool_name: tool, tool_input: { target: 'key_lemma', title: 't', body: 'b', from: 'teaching' } }, root).deny, true, tool);
    assert.equal(teachingToolDecision(paths, { tool_name: tool, tool_input: { target: 'key_lemma', title: 't', body: 'b', origin: 'agent', from: 'loop' } }, root).deny, true, tool);
  }
  // Remark files are written only through remark add, by either chat.
  assert.match(preToolUseDecision(paths, { tool_name: 'Write', tool_input: { file_path: `${root}/research/remarks/remark_1.md`, content: '---\ntype: remark\n---\n' } }, root).reason ?? '', /remark add/);
  assert.match(preToolUseDecision(paths, bash('echo x > research/remarks/remark_1.md'), root).reason ?? '', /remark add/);
  assert.equal(preToolUseDecision(paths, bash('cat research/remarks/remark_1.md'), root).deny, false);
  assert.equal(layoutProblem(paths, 'research/remarks/remark_abc.md'), undefined);
  assert.match(layoutProblem(paths, 'research/remarks/notes/x.md') ?? '', /flat/);
  // The loop's chat: its remarks say from loop, and a checking stage never reads remarks.
  assert.match(loopRemarkDecision(paths, bash(`${loop} remark add --target key_lemma --title t --body b --origin agent --from teaching`), 'execute', root).reason ?? '', /from loop/);
  assert.equal(loopRemarkDecision(paths, bash(`${loop} remark add --target key_lemma --title t --body b --origin agent --from loop`), 'execute', root).deny, false);
  for (const input of [{ tool_name: 'Read', tool_input: { file_path: `${root}/research/remarks/remark_1.md` } }, { tool_name: 'Grep', tool_input: { pattern: 'mirror', path: 'research/remarks' } }, { tool_name: 'Glob', tool_input: { pattern: 'research/remarks/*.md' } }, bash('cat research/remarks/*.md'), bash(`${loop} remark list --target key_lemma`)]) {
    assert.match(loopRemarkDecision(paths, input, 'verify_proof', root).reason ?? '', /checking stage does not read remarks/, JSON.stringify(input));
    assert.equal(loopRemarkDecision(paths, input, 'execute', root).deny, false, JSON.stringify(input));
  }
  assert.equal(loopRemarkDecision(paths, { tool_name: 'Read', tool_input: { file_path: `${root}/research/assets/key_lemma.md` } }, 'verify_proof', root).deny, false);
});

test('a chat that names the teach skill is a teaching chat; one that has driven the loop never becomes one', () => {
  assert.equal(roleSignal('UserPromptSubmit', { prompt: '/teach' }, TEACH_PROMPT_PATTERN), 'teach');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: '$teach key_lemma' }, TEACH_PROMPT_PATTERN), 'teach');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: teachPrompt({ id: 'key_lemma', title: 'Key lemma' }) }, TEACH_PROMPT_PATTERN), 'teach');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: 'continue the loop and teach me nothing' }, TEACH_PROMPT_PATTERN), undefined);
  assert.equal(roleSignal('UserPromptSubmit', { prompt: '/research-loop' }, TEACH_PROMPT_PATTERN), 'drive');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: '$research-loop continue' }, TEACH_PROMPT_PATTERN), 'drive');
  assert.equal(roleSignal('UserPromptSubmit', { prompt: 'what does research-loop do?' }, TEACH_PROMPT_PATTERN), undefined);
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

test('a chat that names a manuscript skill is a writing chat; teaching and writing switch only on the researcher\'s own prompt', () => {
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  for (const prompt of ['/draft-latex intro', '$plan-manuscript', 'Use the plan-manuscript skill to place main_theorem', 'run the revise-manuscript-prose skill on section 2', '/check-notation']) {
    assert.equal(roleSignal('UserPromptSubmit', { prompt }, TEACH_PROMPT_PATTERN), 'write', prompt);
  }
  assert.equal(roleSignal('UserPromptSubmit', { prompt: 'how is the draft going?' }, TEACH_PROMPT_PATTERN), undefined);
  assert.equal(roleSignal('UserPromptSubmit', { prompt: 'Continue the research loop: run research-loop next and follow it.' }, TEACH_PROMPT_PATTERN), 'drive');
  assert.equal(roleSignal('PreToolUse', bash('node .agents/skills/draft-latex/scripts/manuscript-writing.cjs impact'), TEACH_PROMPT_PATTERN), 'write');
  assert.equal(roleSignal('PreToolUse', { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'node .agents/skills/research-loop/scripts/research-loop.cjs next'] } }, TEACH_PROMPT_PATTERN), 'drive');
  // A driver stays the driver. A writing chat drives only when the researcher invokes the loop there; a teaching chat never does.
  assert.equal(nextSessionRole('drive', 'write', true), undefined);
  assert.equal(nextSessionRole('write', 'drive', true), 'drive');
  assert.equal(nextSessionRole('write', 'drive', false), undefined, 'the agent running next does not take over');
  assert.equal(nextSessionRole('teach', 'drive', true), undefined);
  assert.equal(nextSessionRole('teach', 'drive', false), undefined);
  assert.equal(nextSessionRole(undefined, 'write', false), 'write');
  assert.equal(nextSessionRole(undefined, 'drive', false), 'drive');
  // The researcher switches a teaching chat to writing and back; the agent running a preview does not.
  assert.equal(nextSessionRole('teach', 'write', true), 'write');
  assert.equal(nextSessionRole('write', 'teach', true), 'teach');
  assert.equal(nextSessionRole('teach', 'write', false), undefined);
  assert.equal(nextSessionRole('write', 'teach', false), undefined);
  let roles = withSessionRole(parseSessionRoles(''), 'teach', 's1', 'now');
  roles = withSessionRole(roles, 'write', 's1', 'later');
  assert.equal(sessionRole(roles, 's1'), 'write');
  assert.equal(roles.teach.s1, undefined, 'a chat is teaching or writing, not both');
  assert.equal(sessionRole(withSessionRole(roles, 'teach', 's1', 'again'), 's1'), 'teach');
  // A writing chat never drives the loop, but reads it and records what the paper needs.
  const loop = 'node .agents/skills/research-loop/scripts/research-loop.cjs';
  for (const command of ['next', 'report proved --summary x', 'resume', 'pause', 'park a --reason x', 'focus a', 'search request a', 'idea convert idea_1 --asset a', 'budget allocate a 2 --reason x', 'repair request a', 'start --provider claude --intake a,b']) {
    assert.match(writingToolDecision(bash(`${loop} ${command}`)).reason ?? '', /writes the manuscript/, command);
  }
  assert.match(writingToolDecision(bash(`${loop} start --provider claude`)).reason ?? '', /\/research-loop/, 'the refusal says how the researcher hands this chat the loop');
  for (const command of ['status --brief', 'show main_theorem', 'remark list --target a', 'idea add --title t --body b --kind question', 'teach list', 'sync status']) {
    assert.equal(writingToolDecision(bash(`${loop} ${command}`)).deny, false, command);
  }
});

test('a teaching chat may read and record doubts, but not drive the loop or edit the project', () => {
  const root = '/work/project';
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const loop = 'node .agents/skills/research-loop/scripts/research-loop.cjs';
  for (const command of ['teach list', 'teach pack key_lemma', 'status --brief', 'show key_lemma --section Proof', 'search status key_lemma', 'idea add --title t --body b --origin researcher', 'idea add --title t --body b --origin agent', 'library search compactness']) {
    assert.equal(teachingToolDecision(paths, bash(`${loop} ${command}`), root).deny, false, command);
  }
  for (const command of ['next', 'report proved --summary x', 'resume', 'park key_lemma --reason x', 'search request key_lemma', 'idea convert idea_1 --asset a', 'sync pull']) {
    assert.match(teachingToolDecision(paths, bash(`${loop} ${command}`), root).reason ?? '', /teaching chat/, command);
  }
  assert.equal(teachingToolDecision(paths, { tool_name: 'Edit', tool_input: { file_path: `${root}/research/assets/key_lemma.md` } }, root).deny, true);
  // The manuscript script previews and reports freely, but never writes from the teaching chat.
  const manuscript = 'node .agents/skills/draft-latex/scripts/manuscript-writing.cjs';
  for (const command of ['impact', 'impact intro --json', 'prepare intro --preview', 'prepare intro', 'lock intro --preview', 'sync --preview', 'adopt --preview']) {
    assert.equal(teachingToolDecision(paths, bash(`${manuscript} ${command}`), root).deny, false, command);
  }
  for (const command of ['prepare intro --apply', 'lock intro --apply', 'sync --apply', 'adopt --apply', 'impact && node .claude/skills/draft-latex/scripts/manuscript-writing.cjs lock intro --apply']) {
    assert.match(teachingToolDecision(paths, bash(`${manuscript} ${command}`), root).reason ?? '', /does not change the manuscript/, command);
  }
  assert.match(teachingToolDecision(paths, { tool_name: 'shell', tool_input: { command: ['node', 'manuscript-writing.cjs', 'sync', '--apply'] } }, root).reason ?? '', /does not change the manuscript/);
  // An --apply belonging to another command in the same line is not the manuscript script's.
  assert.equal(teachingToolDecision(paths, bash(`${manuscript} impact; echo --apply`), root).deny, false);
  const maintenance = 'node .agents/skills/research-maintenance/scripts/research-maintenance.cjs';
  assert.equal(teachingToolDecision(paths, bash(`${maintenance} validate`), root).deny, false);
  assert.match(teachingToolDecision(paths, bash(`${maintenance} links --apply`), root).reason ?? '', /does not edit project files/);
  // Nor does it edit by shell; scratch files outside the project are fine.
  for (const command of ['sed -i "s/a/b/" research/assets/key_lemma.md', 'echo x > research/ideas/a.md', `cat /tmp/d.md > ${root}/sections/intro.tex`, 'cd research && rm -rf plans', "python3 -c \"open('main.tex','w').write('')\"", 'git checkout -- research']) {
    assert.match(teachingToolDecision(paths, bash(command), root).reason ?? '', /does not edit project files, and this command would write/, command);
  }
  for (const command of ["cat > /tmp/draft.md <<'EOF'\n## Proof\nx\nEOF", `${loop} teach revise key_lemma --file /tmp/draft.md`, 'python3 -c "print(2**10)"', 'git log -3']) {
    assert.equal(teachingToolDecision(paths, bash(command), root).deny, false, command);
  }
  assert.equal(teachingToolDecision(paths, { ...bash('echo x > notes.md'), cwd: '/tmp' }, root).deny, false);
  assert.equal(teachingToolDecision(paths, bash('python3 /tmp/s.py'), root, () => "open('research/a.md', 'w')").deny, true);
  // Every idea recorded here says whose it is: the teaching chat decides, the hooks refuse an idea without it.
  assert.match(teachingToolDecision(paths, bash(`${loop} idea add --title t --body b`), root).reason ?? '', /say whose it is/);
  assert.equal(teachingToolDecision(paths, bash(`${loop} idea add --title t --body b --origin agent && ${loop} idea add --title u --body c`), root).deny, true);
  assert.equal(teachingToolDecision(paths, bash(`${loop} idea add --title t --body b --origin=researcher`), root).deny, false);
  for (const tool of ['mcp__research-assistant__record_idea', 'mcp__research_assistant__record_idea']) {
    assert.match(teachingToolDecision(paths, { tool_name: tool, tool_input: { title: 't', body: 'b' } }, root).reason ?? '', /say whose it is/, tool);
    assert.equal(teachingToolDecision(paths, { tool_name: tool, tool_input: { title: 't', body: 'b', origin: 'agent' } }, root).deny, false, tool);
    assert.equal(teachingToolDecision(paths, { tool_name: tool, tool_input: { title: 't', body: 'b', origin: 'researcher' } }, root).deny, false, tool);
    // The driving chat records ideas as before; only the teaching chat must decide.
    assert.equal(preToolUseDecision(paths, { tool_name: tool, tool_input: { title: 't', body: 'b' } }, root).deny, false, tool);
  }
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

test('a rewording draft holds only the proof and its changes; the legacy remarks block changes no digest', () => {
  assert.deepEqual(parseRevisionDraft(REWORDED), { proof: 'By reflexivity of equality, $n = n$ for every $n$.', changes: 'One sentence instead of a bare citation.' });
  assert.throws(() => parseRevisionDraft('## Remarks\n\nThink of it as a mirror.\n'), /no longer part of a rewording[\s\S]*add_remark/);
  assert.throws(() => parseRevisionDraft(REWORDED + '\n## Remarks\n\nA mirror.\n'), /no longer part of a rewording/);
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
  await f.teaching.propose('key_lemma', REWORDED, 'now');
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

test('a remark is saved at once in its own file, touches no approval, and shows in the pack; a proposal against an older version is dropped', async () => {
  const f = researcherChecks();
  await lemmaApproved(f);
  const before = f.map.get(LEMMA);
  const remark = await f.core.addRemark({ target: 'key_lemma', title: 'A mirror', body: 'Think of it as a mirror.', anchor: 'step 1', origin: 'researcher', from: 'teaching' });
  assert.equal(f.map.get(LEMMA), before, 'the result file is untouched');
  assert.match(f.map.get(remark.file), /^---\ntype: remark\ntitle: A mirror\ntarget: key_lemma\nanchor: step 1\norigin: researcher\nfrom: teaching\nstatus: active\ntarget_digest: [0-9a-f]{64}\n/);
  assert.equal(matter(f.map.get(LEMMA)).data.status, 'approved');
  assert.deepEqual((await f.core.validateWorkspace()).problems, []);
  assert.match(await f.teaching.packText('key_lemma'), /## Remarks on it \(explanations, not part of the proof; no check covers them\)\n\n### A mirror \(remark_[0-9a-f]+, at step 1; the researcher's\)\n\nThink of it as a mirror\./);
  assert.equal(remark.link, `[A mirror](.research-assistant-loop/open/${remark.id}.md)`);
  assert.ok(f.map.has(`.research-assistant-loop/open/${remark.id}.md`), 'a chat link to the remark opens');
  assert.match(await f.teaching.packText('key_lemma'), new RegExp(`- Remark: \\[A mirror\\]\\(\\.research-assistant-loop/open/${remark.id}\\.md\\) \\(file: \\[research/remarks/${remark.id}\\.md\\]`));
  await assert.rejects(f.core.addRemark({ target: 'nothing', title: 't', body: 'b', origin: 'agent', from: 'teaching' }), /No asset or definition named nothing/);
  // The loop writes remarks only on its current result, at most two per stage; it never edits the researcher's.
  await assert.rejects(f.core.addRemark({ target: 'key_lemma', title: 't', body: 'b', origin: 'agent', from: 'loop' }), /only while it works on a result|only on the result it is working on/);
  await assert.rejects(f.core.editRemark(remark.id, { body: 'Changed.' }, 'loop'), /may change only its own remarks/);
  await f.core.editRemark(remark.id, { body: 'Think of it as a mirror image.' }, 'teaching');
  assert.match(f.map.get(remark.file), /mirror image/);
  // A result that changes later leaves its remarks in place, marked as written for an earlier version.
  f.map.set(LEMMA, f.map.get(LEMMA).replace('Equality is reflexive.', 'Equality is reflexive, by definition.'));
  assert.equal((await f.core.remarks().list({ target: 'key_lemma' }))[0].stale, true);
  await f.core.archiveRemark(remark.id, 'teaching');
  assert.deepEqual(await f.core.remarks().list({ target: 'key_lemma' }), []);
  // An agent's remark is unchecked until the researcher checks it in the dashboard; an edit unchecks it again.
  const agents = await f.core.addRemark({ target: 'key_lemma', title: 'A guess', body: 'The constant is uniform.', origin: 'agent', from: 'teaching' });
  const listed = async () => (await f.core.remarks().list({ target: 'key_lemma' })).find((item) => item.id === agents.id);
  assert.equal((await listed()).checked, false);
  const { remarkLabel } = load('../src/domain/remarks.ts');
  assert.match(remarkLabel(await listed(), false), /an agent's, not checked by anyone/);
  await f.core.checkRemark(agents.id, 'dashboard');
  assert.equal((await listed()).checked, true);
  assert.match(remarkLabel(await listed(), false), /an agent's, checked by the researcher/);
  await f.core.editRemark(agents.id, { body: 'The constant is uniform in t.' }, 'teaching');
  assert.equal((await listed()).checked, false, 'a check covers the text it was given for');
  // Approving it for the paper checks it; archiving and restoring keep that approval.
  await f.core.approveRemark(agents.id, 'dashboard');
  assert.deepEqual([(await listed()).checked, (await listed()).approved], [true, true]);
  await f.core.archiveRemark(agents.id, 'other');
  await f.core.restoreRemark(agents.id, 'other');
  assert.equal((await listed()).approved, true);
  await f.core.archiveRemark(agents.id, 'other');
  await f.core.restoreRemark(remark.id, 'other');
  assert.deepEqual((await f.core.remarks().list({ target: 'key_lemma' })).map((item) => item.id), [remark.id], 'an archived remark can come back');
  await f.core.archiveRemark(remark.id, 'other');
  // A proposal from before remarks had files: its remarks become a remark file.
  const { understandingParts } = load('../src/domain/understanding.ts');
  f.map.set('.research-assistant-loop/revisions/key_lemma.json', JSON.stringify({ id: 'key_lemma', remarks: 'An old note.', baseStatement: understandingParts(f.map.get(LEMMA)).statementDigest, at: 'then' }));
  await f.core.next();
  const legacy = (await f.core.remarks().list({ target: 'key_lemma' }));
  assert.deepEqual(legacy.map((item) => [item.body, item.origin, item.from]), [['An old note.', 'researcher', 'teaching']]);
  assert.equal(f.map.has('.research-assistant-loop/revisions/key_lemma.json'), false);

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
