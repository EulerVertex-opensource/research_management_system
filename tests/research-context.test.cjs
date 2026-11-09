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
const { planContext, renderContext, estimateTokens } = load('../src/services/ResearchContext.ts');
const { researchReads } = load('../src/services/ResearchLoopHooks.ts');
const { hookEntries, buildWorkerAgent } = load('../src/services/AgentIntegrationCore.ts');
const cli = path.resolve(__dirname, '../out/research-loop.cjs');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '# Project\n\n## Main Problem\n\nProve A.\n\n## Current Goals\n\nFind a proof.\n\n## Required Results\n\n- main_theorem: the central claim\n\n## Known Results\n\nNone.\n';
const node = (data, body) => matter.stringify(body, data);
const theorem = (extra = {}, proof = '') => node({ type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'self_proved' }, depends_on: ['helper_lemma'], uses_definitions: ['widget'], ...extra }, `\n## Statement\n\nEvery widget is blue.\n${proof}`);
const lemma = node({ type: 'lemma', title: 'Helper', status: 'draft', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: ['gadget'] }, '\n## Statement\n\nHELPER STATEMENT.\n\n## Proof\n\nHELPER PROOF SECRET.\n');
const widget = node({ type: 'definition', title: 'Definition (widget)', status: 'draft', depends_on: ['gadget'] }, '\nA widget is a blue gadget.\n');
const gadget = node({ type: 'definition', title: 'Definition (gadget)', status: 'draft', depends_on: [] }, '\nA gadget is a thing.\n');
const unrelated = node({ type: 'definition', title: 'Definition (sprocket)', status: 'draft', depends_on: [] }, '\nUNRELATED DEFINITION.\n');
const failedPlan = (id) => node({ type: 'plan', title: id, status: 'failed', target_asset: 'main_theorem', inspired_by: [] }, `\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\nRoute ${id}.\n\n## Plan\n\n1. [ ] CHECKLIST STEP ${id}.\n\n## Verification\n\nCombine.\n\n## Failure\n\nOBSTRUCTION ${id}.\n`);

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

function sources(extra = {}) {
  const nodes = (entries, folder) => new Map(Object.entries(entries).map(([id, raw]) => { const parsed = matter(raw); return [id, { id, file: `${folder}/${id}.md`, raw, data: parsed.data, body: parsed.content }]; }));
  return {
    project, projectFile: 'research/project.md', paperIndex: '# Papers\n\n## smith2020\n\nhttps://arxiv.org/abs/1\n\nLong description that should not appear.\n', paperIndexFile: 'research/papers.md',
    assets: nodes({ main_theorem: theorem({}, '\n## Proof\n\nTARGET PROOF SECRET.\n'), helper_lemma: lemma, ...(extra.assets ?? {}) }, 'research/assets'),
    definitions: nodes({ widget, gadget, sprocket: unrelated }, 'research/definitions'),
    plans: nodes(extra.plans ?? {}, 'research/plans'), ideas: nodes(extra.ideas ?? {}, 'research/ideas'), checks: nodes({}, 'research/checks'),
    reports: extra.reports ?? [],
  };
}

test('search pack holds the statement, direct dependencies, definition closure, board, and slot, but no proofs', () => {
  const s = sources();
  const slot = { slot: 2, direction: 'small_cases', label: 'Smallest instances.' };
  const manifest = planContext({ stage: 'search', assetId: 'main_theorem', search: { mode: 'refute', round: 3, slot, board: '## Search board\n\nBOARD OBSTRUCTION' } }, s);
  const pack = renderContext(manifest, s, 'loop show');
  assert.match(pack.text, /BOARD OBSTRUCTION/);
  assert.match(pack.text, /Your slot: 2, round 3\. Direction small_cases: Smallest instances\./);
  assert.match(pack.text, /the other slots of this round/);
  assert.match(pack.text, /Every widget is blue/);
  assert.match(pack.text, /HELPER STATEMENT/);
  assert.match(pack.text, /A widget is a blue gadget/);
  assert.match(pack.text, /A gadget is a thing/);
  assert.doesNotMatch(pack.text, /TARGET PROOF SECRET|HELPER PROOF SECRET|UNRELATED DEFINITION/);
  assert.equal(manifest.worker, 'deep');
  assert.ok(pack.files.includes('research/assets/main_theorem.md'));
  assert.ok(!pack.files.includes('research/definitions/sprocket.md'));
});

test('plan pack keeps only Goal and Failure of failed plans plus related ideas and earlier reports', () => {
  const idea = node({ type: 'idea', title: 'Use colour', status: 'draft', related_assets: ['main_theorem'] }, '\nFIRST PARAGRAPH.\n\nSECOND PARAGRAPH.\n');
  const s = sources({ plans: { attempt_1: failedPlan('attempt_1') }, ideas: { colour: idea }, reports: [{ stage: 'search', outcome: 'searched', summary: 'Checked small widgets', assetId: 'main_theorem' }, { stage: 'plan', outcome: 'complete', summary: 'OTHER ASSET', assetId: 'other' }] });
  const pack = renderContext(planContext({ stage: 'plan', assetId: 'main_theorem', changesRequested: 'Use induction' }, s), s, 'loop show');
  assert.match(pack.text, /OBSTRUCTION attempt_1/);
  assert.match(pack.text, /Route attempt_1/);
  assert.doesNotMatch(pack.text, /CHECKLIST STEP/);
  assert.match(pack.text, /FIRST PARAGRAPH/);
  assert.doesNotMatch(pack.text, /SECOND PARAGRAPH/);
  assert.match(pack.text, /search → searched: Checked small widgets/);
  assert.doesNotMatch(pack.text, /OTHER ASSET/);
  assert.match(pack.text, /requested changes: Use induction/);
});

test('plan pack offers ideas from similar results, dead ends, and observations to promote, without any link to the target', () => {
  const result = (title, definition, statement, status = 'draft') => node({ type: 'theorem', title, status, source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [definition] }, `\n## Statement\n\n${statement}\n`);
  const idea = (title, kind, related, body, status = 'draft') => node({ type: 'idea', title, status, idea_kind: kind, related_assets: related }, body);
  const plan = (target, status, ideas) => node({ type: 'plan', title: `plan for ${target}`, status, target_asset: target, inspired_by: ideas }, `\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\nGo.\n\n## Plan\n\n1. [ ] Step.\n\n## Verification\n\nDone.\n${status === 'failed' ? '\n## Failure\n\nStuck.\n' : status === 'succeeded' ? '\n## Outcome\n\nProved.\n' : ''}`);
  const s = sources({
    assets: { similar_widget: result('Widget colour theorem', 'widget', 'Widgets are colourful.', 'approved'), far_sprocket: result('Sprocket theorem', 'sprocket', 'Sprockets turn.') },
    ideas: {
      paint: idea('Paint argument', 'approach', ['similar_widget'], '\nREUSABLE TRICK.\n'),
      spectral: idea('Spectral trick', 'approach', [], '\nPROVED SIMILAR.\n'),
      sprocket_idea: idea('Gear count', 'approach', ['far_sprocket'], '\nSPROCKET IDEA.\n'),
      red: idea('Widgets are never red', 'observation', ['similar_widget'], '\nThey seemed blue.\n\n## Refutation\n\nWIDGETS CAN BE RED.\n', 'refuted'),
      reflect: idea('Widgets reflect light', 'observation', ['main_theorem'], '\nREFLECTION.\n'),
      reuse: idea('Compare with gadgets', 'approach', ['main_theorem'], '\nLINKED AND USED.\n'),
    },
    plans: { p_similar: plan('similar_widget', 'succeeded', ['spectral', 'reuse']), p_reflect: plan('similar_widget', 'failed', ['reflect']) },
  });
  const pack = renderContext(planContext({ stage: 'plan', assetId: 'main_theorem' }, s), s, 'loop show').text;
  assert.match(pack, /### Ideas from similar results \(not linked to this one\)/);
  assert.match(pack, /- spectral \(approach\): Spectral trick\. Why: used by p_similar, which proved the similar result similar_widget; used for similar_widget \(succeeded\)\. PROVED SIMILAR\./);
  assert.match(pack, /- paint \(approach\): Paint argument\. Why: recorded for the similar result similar_widget\. REUSABLE TRICK\./);
  assert.ok(pack.indexOf('- spectral') < pack.indexOf('- paint'), 'an idea that proved a similar result ranks first');
  assert.doesNotMatch(pack, /SPROCKET IDEA/);
  assert.match(pack, /### Dead ends near this result[\s\S]*- red \(observation, refuted\): Widgets are never red\. Why shown: recorded for the similar result similar_widget\. Refutation: WIDGETS CAN BE RED\./);
  assert.match(pack, /### Linked ideas plans already used\n\n- reflect \(observation\): Widgets reflect light; used for similar_widget \(failed\)\n- reuse \(approach\): Compare with gadgets; used for similar_widget \(succeeded\)/);
  assert.match(pack, /### Observations to promote before relying on them\n\n- reflect: plans for similar_widget already rely on it\. If this plan needs it too, promote it to a lemma first \(idea promote reflect --id <lemma_id> --statement "\.\.\." --into main_theorem\)/);
  // Linked open ideas are still in the pack, used or not.
  assert.match(pack, /LINKED AND USED/);
  assert.match(pack, /REFLECTION/);
  // A refuted observation linked to the target reaches a counterexample search too.
  const linkedRed = sources({ ideas: { red: idea('Widgets are never red', 'observation', ['main_theorem'], '\nThey seemed blue.\n\n## Refutation\n\nWIDGETS CAN BE RED.\n', 'refuted') } });
  const search = renderContext(planContext({ stage: 'search', assetId: 'main_theorem', search: { mode: 'refute', round: 1, slot: { slot: 1, direction: 'small_cases', label: 'Small.' }, board: '' } }, linkedRed), linkedRed, 'loop show').text;
  assert.match(search, /### idea red \[Refutation\][\s\S]*WIDGETS CAN BE RED/);
});

test('over budget, whole low-priority items are dropped and listed; priority 0 always stays', () => {
  const plans = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`attempt_${index}`, failedPlan(`attempt_${index}`).replace('OBSTRUCTION', 'OBSTRUCTION ' + 'x'.repeat(2000))]));
  const s = sources({ plans });
  const pack = renderContext(planContext({ stage: 'plan', assetId: 'main_theorem' }, s, 1200), s, 'loop show');
  assert.match(pack.text, /Every widget is blue/);
  assert.ok(pack.omitted.length > 0);
  assert.match(pack.text, /Available on request/);
  for (const item of pack.omitted) assert.doesNotMatch(pack.text, new RegExp(`### plan ${item.id} `));
  assert.ok(pack.tokens <= 1200 + estimateTokens('x'.repeat(600)));
  const tiny = renderContext(planContext({ stage: 'plan', assetId: 'main_theorem' }, s, 10), s, 'loop show');
  assert.match(tiny.text, /Every widget is blue/);
});

test('scaffold uses a one-line index instead of node bodies; sources shows paper headings and URLs only', () => {
  const s = sources();
  const scaffold = renderContext(planContext({ stage: 'scaffold', missing: ['new_lemma'] }, s), s, 'loop show');
  assert.match(scaffold.text, /helper_lemma \| lemma \| draft \| deps=\[\] \| Helper/);
  assert.match(scaffold.text, /Missing asset IDs to create: new_lemma/);
  assert.doesNotMatch(scaffold.text, /HELPER STATEMENT/);
  assert.equal(planContext({ stage: 'scaffold' }, s).worker, 'light');
  const sourcesPack = renderContext(planContext({ stage: 'sources' }, s), s, 'loop show');
  assert.match(sourcesPack.text, /## smith2020/);
  assert.match(sourcesPack.text, /arxiv\.org/);
  assert.doesNotMatch(sourcesPack.text, /Long description/);
});

test('next writes the pack and manifest, names the worker, and show serves sections and audits reads', async () => {
  const s = { 'research/project.md': project, 'research/papers.md': '# Papers\n', 'research/assets/main_theorem.md': theorem(), 'research/assets/helper_lemma.md': lemma, 'research/definitions/widget.md': widget, 'research/definitions/gadget.md': gadget, 'research/definitions/sprocket.md': unrelated };
  const files = memoryFiles(s);
  let clock = 0;
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++clock}`, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString() });
  await core.start('claude', { goal: 'Prove it' });
  const next = await core.next();
  assert.equal(next.stage, 'review_project');
  assert.equal(next.brief.context.file, '.research-assistant-loop/context/current.md');
  assert.match(files.map.get('.research-assistant-loop/context/current.md'), /Context pack: stage review_project/);
  assert.match(next.instruction, /Context pack \(~\d+ tokens\)/);
  const shown = await core.show('helper_lemma', ['Statement']);
  assert.match(shown, /HELPER STATEMENT/);
  assert.doesNotMatch(shown, /HELPER PROOF SECRET/);
  assert.match(await core.show('helper_lemma'), /HELPER PROOF SECRET/);
  await assert.rejects(core.show('nope'), /No node or paper/);
  assert.equal(await core.noteRead('research/project.md', 'Read'), false);
  const audit = await core.contextAudit();
  assert.deepEqual(audit.requests, ['helper_lemma#Statement', 'helper_lemma']);
  assert.ok(audit.tokens > 0);
});

test('paper show gives the outline unless a section or --full is asked for', async () => {
  const paper = '# Smith 2020\n\n## 1 Introduction\n\nINTRO TEXT.\n\n## 2 Main result\n\n### Theorem 2.1\n\nTHEOREM TEXT.\n\n## 3 Appendix\n\nAPPENDIX.\n';
  const files = memoryFiles({ 'research/project.md': project, 'research/papers/smith2020/paper.md': paper });
  const core = new ResearchLoopCore(files, paths, { id: () => 'x' });
  const outline = await core.show('smith2020');
  assert.match(outline, /## 2 Main result/);
  assert.doesNotMatch(outline, /THEOREM TEXT/);
  const part = await core.show('smith2020', ['Main result']);
  assert.match(part, /THEOREM TEXT/);
  assert.doesNotMatch(part, /APPENDIX|INTRO TEXT/);
  assert.equal(await core.show('smith2020', [], true), paper);
});

test('researchReads maps read tool calls to research files and folders', () => {
  const root = '/proj';
  assert.deepEqual(researchReads(paths, { tool_name: 'Read', tool_input: { file_path: '/proj/research/assets/x.md' } }, root), ['research/assets/x.md']);
  assert.deepEqual(researchReads(paths, { tool_name: 'Glob', tool_input: { pattern: 'research/assets/*.md' } }, root), ['research/assets']);
  assert.deepEqual(researchReads(paths, { tool_name: 'Bash', tool_input: { command: 'cat research/plans/p.md research/definitions/d.md' } }, root), ['research/plans/p.md', 'research/definitions/d.md']);
  assert.deepEqual(researchReads(paths, { tool_name: 'Read', tool_input: { file_path: '/proj/main.tex' } }, root), []);
});

test('Claude gets a PostToolUse read audit and worker subagents; researcher-edited workers are kept', () => {
  assert.ok(hookEntries('/x/research-loop.cjs', 'claude').PostToolUse);
  assert.equal(hookEntries('/x/research-loop.cjs', 'codex').PostToolUse, undefined);
  const light = buildWorkerAgent('light', '', '.claude/skills', 'node loop.cjs');
  assert.match(light, /^---\nname: research-worker-light\n/);
  assert.match(light, /model: sonnet/);
  assert.match(buildWorkerAgent('deep', '', '.claude/skills', 'node loop.cjs'), /model: inherit/);
  const deep = buildWorkerAgent('deep', '', '.claude/skills', 'node loop.cjs', 'node maint.cjs');
  assert.match(deep, /\nexperimental:\n  cacheTtl: 1h\n---\n/, 'deep workers keep the one-hour cache through long turns');
  assert.doesNotMatch(light, /cacheTtl/);
  assert.match(deep, /`node loop\.cjs library search/);
  assert.match(deep, /`node maint\.cjs validate`/);
  assert.match(deep, /`partial: <what remains>`/);
  assert.equal(buildWorkerAgent('light', light, '.claude/skills', 'node loop.cjs'), light);
  assert.equal(buildWorkerAgent('light', '---\nname: research-worker-light\n---\nmine', '.claude/skills', 'node loop.cjs'), undefined);
});

test('CLI context and show commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-context-'));
  try {
    const config = { version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' }, contextBudgets: { review_project: 5000 } };
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    write('.research-assistant.json', JSON.stringify(config));
    write('research/project.md', project);
    write('research/papers.md', '# Papers\n');
    write('research/assets/helper_lemma.md', lemma);
    const run = (args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' });
    assert.equal(run(['start', '--provider', 'codex', '--goal', 'Prove it']).status, 0);
    const context = run(['context', '--json']);
    assert.equal(context.status, 0, context.stderr);
    const parsed = JSON.parse(context.stdout);
    assert.equal(parsed.manifest.budget, 5000);
    assert.equal(parsed.manifest.stage, 'review_project');
    const show = run(['show', 'helper_lemma', '--section', 'Statement']);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /HELPER STATEMENT/);
    assert.doesNotMatch(show.stdout, /HELPER PROOF SECRET/);
    assert.match(run(['status']).stdout, /Context: pack ~\d+\/5000 tokens; 1 show request/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
