const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, external = []) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'], external });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { buildGraphPayload } = load('../src/services/GraphViewModel.ts');
const { loadManuscriptModel, loadImpactNodes, readSectionBriefFile } = load('../src/services/ManuscriptImpactLoader.ts');
const { lockBinding } = load('../src/domain/manuscriptImpact.ts');
const { researchDigest } = load('../src/domain/digests.ts');
const { computeAttention } = load('../src/domain/attention.ts');
const { visibleGraph, transitiveReduction, impactOf, goalGraph, needsGraph, traceGraph, waitingItems, blockingStates, defaultGoal, DEFAULT_OPTIONS, MAX_VISIBLE } = load('../webview-src/graph/graphModel.ts');
const { layout } = load('../webview-src/graph/layout.ts');
const { computeLoopHealth } = load('../src/domain/loopHealth.ts');
const { buildHistory } = load('../src/domain/history.ts');
const { OverviewPage } = load('../webview-src/graph/OverviewPage.tsx', ['react']);
const { NeedsYouPage } = load('../webview-src/graph/NeedsYouPage.tsx', ['react']);
const { CoverageMatrix } = load('../webview-src/graph/CoverageMatrix.tsx', ['react']);
const { ProgressView } = load('../webview-src/graph/ProgressView.tsx', ['react']);

const paths = { researchRoot: 'research', projectMd: 'research/project.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', sections: 'sections', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main\n  - id: second\n---\n\n## Main Problem\n\nP.\n\n## Scope and Assumptions\n\nS.\n\n## Intended Contribution\n\nC.\n';
const node = (type, data, body = '## Statement\n\nA statement.\n') => matter.stringify(`\n${body}`, { type, title: data.title ?? type, status: data.status ?? 'approved', ...(type === 'definition' ? {} : { source: { kind: 'original' }, uses_definitions: data.defs ?? [] }), depends_on: data.deps ?? [], ...data.extra });

function memoryFiles(initial) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
  };
}

function researchNodes(files) {
  return [...files.map.keys()].filter((file) => /^research\/(assets|definitions|ideas|plans)\/.*\.md$/.test(file)).map((file) => {
    const { data, content } = matter(files.map.get(file));
    return { id: path.posix.basename(file, '.md'), filePath: file, body: content, tags: [], depends_on: [], uses_definitions: [], related_assets: [], ...data };
  });
}

async function fixture() {
  const files = memoryFiles({
    'research/project.md': project,
    'research/approvals/project.json': JSON.stringify({ kind: 'project', target: 'project', digest: researchDigest(project, 'project'), approvedAt: 'then' }),
    'research/definitions/widget.md': node('definition', { title: 'Widget' }),
    'research/assets/helper.md': node('lemma', { title: 'Helper', defs: ['widget'] }),
    'research/assets/main.md': node('theorem', { title: 'Main', deps: ['helper'], defs: ['widget'] }, '## Statement\n\nMain.\n\n## Proof\n\nBy helper.\n'),
    'research/assets/second.md': node('theorem', { title: 'Second', status: 'draft', deps: ['helper'] }),
    'research/assets/side.md': node('lemma', { title: 'Side', status: 'draft' }),
    'research/assets/cex.md': node('example', { title: 'Cex', status: 'draft', extra: { refutes: 'second' } }),
    'research/plans/p1.md': matter.stringify('\nx\n', { type: 'plan', title: 'P1', status: 'failed', target_asset: 'second' }),
    'research/plans/p2.md': matter.stringify('\nx\n', { type: 'plan', title: 'P2', status: 'pending', target_asset: 'second' }),
    'research/ideas/i1.md': matter.stringify('\nx\n', { type: 'idea', title: 'I1', status: 'draft', related_assets: ['helper'] }),
    'research/writing/outline.md': '# Outline\n\n## Sections\n\n1. [Introduction](sections/sec_intro.md)\n2. [Main result](sections/sec_main.md)\n3. [Second](sections/sec_new.md)\n',
    'research/writing/sections/sec_intro.md': '---\ntitle: Introduction\nsources:\n  - id: main\n    uses: [statement]\nproject_facets: [contribution]\n---\n',
    'research/writing/sections/sec_main.md': '---\ntitle: Main result\nassets: [main]\n---\n',
    'research/writing/sections/sec_new.md': '---\ntitle: Second\nassets: [second]\n---\n',
    'sections/sec_intro.tex': 'Intro.\n',
    'sections/sec_main.tex': '\\section{Main}\n% research-assistant:block id=main-proof sources=main@proof\nProof.\n% research-assistant:endblock\n',
    'sections/sec_new.tex': 'Draft.\n',
  });
  const nodes = await loadImpactNodes(files, paths);
  for (const [id, title] of [['sec_intro', 'Introduction'], ['sec_main', 'Main result']]) {
    const brief = await readSectionBriefFile(files, paths, { id, title });
    const binding = lockBinding({ section: id, tex: `sections/${id}.tex`, texRaw: files.map.get(`sections/${id}.tex`), brief, nodes, project, projectRevision: 1, lockedAt: 'then' });
    files.map.set(`research/writing/bindings/${id}.json`, JSON.stringify(binding));
  }
  files.map.set('research/assets/main.md', node('theorem', { title: 'Main', deps: ['helper'], defs: ['widget'] }, '## Statement\n\nMain.\n\n## Proof\n\nBy helper, differently.\n'));
  const state = {
    status: 'running', stage: 'plan', current: { assetId: 'second' }, parked: { side: { reason: 'three_failed_plans', at: '2026-01-03T00:00:00Z' } },
    pendingQuestion: { id: 'q1', kind: 'discussion', prompt: 'Which norm?', assetId: 'second', createdAt: '2026-01-01T00:00:00Z' },
    approvalQueue: [
      { id: 'r1', kind: 'asset', target: 'second', digest: 'd', reason: 'Proof written.', requestedAt: '2026-01-02T00:00:00Z' },
      { id: 'r2', kind: 'asset', target: 'side', digest: 'd', reason: 'Supporting lemma.', requestedAt: '2026-01-02T00:00:00Z' },
      { id: 'r3', kind: 'counterexample', target: 'cex', digest: 'd', reason: 'Candidate.', requestedAt: '2026-01-02T00:00:00Z' },
    ],
  };
  const manuscript = await loadManuscriptModel(files, paths);
  const payload = buildGraphPayload({ nodes: researchNodes(files), project, projectApproved: true, state, manuscript, sectionsDir: 'sections', now: 'now' });
  return { payload, byId: new Map(payload.nodes.map((item) => [item.id, item])) };
}

test('the payload groups nodes by the required result they serve and marks what needs a look', async () => {
  const { payload, byId } = await fixture();
  assert.deepEqual(payload.required, ['main', 'second']);
  assert.equal(payload.manuscriptState, 'stale');
  assert.deepEqual(payload.loop, { status: 'running', stage: 'plan', assetId: 'second' });
  assert.equal(byId.get('helper').lane, 'shared');
  assert.equal(byId.get('widget').lane, 'shared');
  assert.equal(byId.get('main').lane, 'main');
  assert.equal(byId.get('side').lane, 'other');
  assert.equal(byId.get('side').inScope, false);
  assert.deepEqual(byId.get('helper').blocks, ['main', 'second']);
  assert.deepEqual(byId.get('second').flags, ['awaiting_approval', 'question', 'counterexample', 'active']);
  assert.deepEqual(byId.get('side').flags, ['awaiting_approval', 'parked']);
  assert.deepEqual(byId.get('main').flags, ['manuscript_stale']);
  assert.deepEqual(byId.get('second').counts, { plans: 2, failedPlans: 1, pendingPlans: 1, ideas: 0 });
  assert.equal(byId.get('helper').counts.ideas, 1);
  assert.deepEqual(byId.get('main').definitions, ['widget']);
  assert.deepEqual(byId.get('main').sections, ['sec_intro', 'sec_main']);
  assert.equal(byId.get('cex').refutes, 'second');
  assert.ok(!payload.nodes.some((item) => item.id === 'p1' || item.id === 'i1'), 'plans and ideas are counts, not nodes');
  assert.deepEqual(payload.edges.find((edge) => edge.type === 'refutes'), { from: 'cex', to: 'second', type: 'refutes' });
});

test('coverage shows each presentation and its freshness; sections carry their blocks', async () => {
  const { payload } = await fixture();
  const main = payload.coverage.find((row) => row.id === 'main');
  assert.equal(main.cells.sec_main.state, 'stale');
  assert.deepEqual(main.cells.sec_main.blocks, ['main-proof']);
  assert.equal(main.cells.sec_intro.state, 'current');
  assert.deepEqual(main.cells.sec_intro.uses, ['statement']);
  assert.equal(payload.coverage.find((row) => row.id === 'helper').cells.sec_main.state, 'dependency');
  assert.equal(payload.coverage.find((row) => row.id === 'second').cells.sec_new.state, 'planned');
  const section = payload.sections.find((item) => item.id === 'sec_main');
  assert.deepEqual(section.blocks.map((block) => [block.id, block.state, block.lines]), [['main-proof', 'stale', [2, 4]]]);
  assert.deepEqual(section.reasons, ['main proof changed']);
  assert.equal(payload.sections.find((item) => item.id === 'sec_new').state, 'unlocked');
});

test('attention: a question first, then what holds up a main result, then what can wait, then housekeeping', async () => {
  const { payload } = await fixture();
  assert.deepEqual(payload.attention.map((item) => `${item.priority}:${item.key}`), [
    '0:question:q1', '1:approval:r1', '1:approval:r3', '2:parked:side', '2:section:sec_main', '4:approval:r2', '4:section:sec_new',
  ]);
  const counterexample = payload.attention.find((item) => item.key === 'approval:r3');
  assert.equal(counterexample.title, 'Check a possible counterexample to Second');
  assert.match(counterexample.why, /If it holds, Second is false/);
  const review = payload.attention.find((item) => item.key === 'approval:r1');
  assert.equal(review.title, 'Review the proof of Second');
  assert.deepEqual(review.buttons.map((button) => button.label), ['Read the proof', 'Accept proof', 'Ask for changes…']);
  assert.equal(review.ifIgnored, 'Second keeps waiting. Other work continues.');
  assert.ok(payload.attention.every((item) => !/\b(P[0-3]|three_failures|asset|Lock)\b/.test(`${item.title} ${item.why} ${item.ifIgnored}`)), 'no internal words in cards');
  assert.deepEqual(counterexample.blocks, ['second']);
  const stale = payload.attention.find((item) => item.key === 'section:sec_main');
  assert.equal(stale.buttons[0].action.action, 'agent');
  assert.match(stale.buttons[0].action.prompt, /manuscript-writing prepare sec_main/);
  assert.equal(stale.buttons[1].action.line, 2);
  assert.equal(payload.attention[0].buttons.find((button) => button.needsText).action.action, 'answer');
});

test('attention ranks a stale statement above a stale proof, and more blocked results first', () => {
  const nodes = new Map([['a', { blocks: ['x', 'y'], sections: [] }], ['b', { blocks: ['x'], sections: [] }]]);
  const section = (id, reasons) => ({ id, title: id, state: 'stale', texPath: '', texExists: true, sources: [], bound: [], blocks: [], reasons });
  const items = computeAttention({
    nodes, required: ['x', 'y'], uncovered: [{ id: 'y', pending: false }, { id: 'z', pending: true }],
    sections: [section('proofs', ['a proof changed']), section('statements', ['a statement changed'])],
    state: { approvalQueue: [{ id: 'r-b', kind: 'asset', target: 'b', reason: '', requestedAt: '1' }, { id: 'r-a', kind: 'asset', target: 'a', reason: '', requestedAt: '2' }], parked: {} },
  });
  assert.deepEqual(items.map((item) => item.key), ['approval:r-a', 'approval:r-b', 'section:statements', 'section:proofs', 'uncovered:y']);
  assert.equal(items[2].priority, 1);
  assert.equal(items[3].priority, 2);
});

test('the visible graph starts from the required scope, hides definitions and implied edges, and filters keep paths', async () => {
  const { payload } = await fixture();
  let visible = visibleGraph(payload, DEFAULT_OPTIONS);
  assert.deepEqual(visible.nodes.map((item) => item.id).sort(), ['cex', 'helper', 'main', 'second']);
  assert.deepEqual(visible.edges.map((edge) => `${edge.from}>${edge.to}`).sort(), ['cex>second', 'main>helper', 'second>helper']);
  visible = visibleGraph(payload, { ...DEFAULT_OPTIONS, showDefinitions: true });
  assert.equal(visible.reduced, 1, 'main>widget is implied by main>helper>widget');
  assert.ok(visible.nodes.some((item) => item.id === 'widget'));
  visible = visibleGraph(payload, { ...DEFAULT_OPTIONS, search: 'helper' });
  assert.deepEqual(visible.nodes.map((item) => item.id).sort(), ['helper', 'main', 'second']);
  visible = visibleGraph(payload, { ...DEFAULT_OPTIONS, filter: 'active' });
  assert.deepEqual(visible.nodes.map((item) => item.id), ['second']);
  visible = visibleGraph(payload, { ...DEFAULT_OPTIONS, focus: { id: 'main', depth: 1 } });
  assert.deepEqual(visible.nodes.map((item) => item.id).sort(), ['helper', 'main']);
  visible = visibleGraph(payload, { ...DEFAULT_OPTIONS, scope: 'all' });
  assert.ok(visible.nodes.some((item) => item.id === 'side'));

  const many = { ...payload, nodes: Array.from({ length: MAX_VISIBLE + 1 }, (_, index) => ({ ...payload.nodes.find((item) => item.kind === 'asset'), id: `n${index}`, inScope: true, status: 'draft' })), edges: [] };
  assert.equal(visibleGraph(many, DEFAULT_OPTIONS).overCap, true);
  assert.equal(visibleGraph(many, DEFAULT_OPTIONS, true).nodes.length, MAX_VISIBLE + 1);
});

test('transitive reduction keeps only edges no longer path implies', () => {
  const edges = [['a', 'b'], ['b', 'c'], ['a', 'c'], ['a', 'd']].map(([from, to]) => ({ from, to, type: 'depends_on' }));
  assert.deepEqual(transitiveReduction(edges).edges.map((edge) => `${edge.from}>${edge.to}`), ['a>b', 'b>c', 'a>d']);
});

test('impact of a definition reaches its dependants and the manuscript passages presenting them', async () => {
  const { payload } = await fixture();
  const widget = impactOf(payload, 'widget');
  assert.deepEqual(widget.downstream.map((item) => item.id).sort(), ['helper', 'main', 'second']);
  assert.deepEqual(widget.sections.map((item) => item.section.id), ['sec_intro', 'sec_main', 'sec_new']);
  assert.deepEqual(widget.sections[1].blocks.map((block) => [block.id, block.via, block.lines]), [['main-proof', ['main'], [2, 4]]]);
  const main = impactOf(payload, 'main');
  assert.deepEqual(main.upstream.map((item) => item.id).sort(), ['helper', 'widget']);
  assert.deepEqual(main.unaffected.map((item) => item.id), ['sec_new']);
});

test('layout reads top to bottom: prerequisites above what rests on them, main results on the bottom row', async () => {
  const { payload } = await fixture();
  const visible = visibleGraph(payload, { ...DEFAULT_OPTIONS, mode: 'all', showDefinitions: true, scope: 'all' });
  const placed = layout(visible.nodes.map((node) => ({ id: node.id, required: node.required })), visible.edges.filter((edge) => edge.type !== 'refutes'));
  const y = (id) => placed.positions.get(id).y;
  assert.ok(y('widget') < y('helper') && y('helper') < y('main') && y('helper') < y('second'));
  assert.equal(y('main'), y('second'), 'both main results end on the bottom row');
  assert.equal(y('main'), Math.max(...[...placed.positions.values()].map((item) => item.y)));
  const boxes = [...placed.positions.values()];
  for (const a of boxes) for (const b of boxes) if (a !== b) assert.ok(a.y !== b.y || Math.abs(a.x - b.x) >= 216, `${a.id} overlaps ${b.id}`);
});

test('nodes carry one of five states, and main results how much of what they rest on is done', async () => {
  const { byId } = await fixture();
  assert.deepEqual([byId.get('main').progress, byId.get('main').progressLabel], ['done', 'Done']);
  assert.deepEqual([byId.get('second').progress, byId.get('second').progressLabel], ['needs_you', 'Check counterexample']);
  assert.deepEqual([byId.get('side').progress, byId.get('side').progressLabel, byId.get('side').progressDetail], ['stuck', 'Set aside', '']);
  assert.deepEqual(byId.get('main').closure, { done: 3, total: 3 });
  assert.deepEqual(byId.get('second').closure, { done: 2, total: 3 });
  assert.equal(byId.get('helper').statement, 'A statement.');
  assert.deepEqual([byId.get('widget').kind, byId.get('widget').progress, byId.get('widget').progressLabel], ['definition', 'done', 'Agreed']);
});

test('the goal view folds finished branches; the needs view keeps only blockers and what they hold up', async () => {
  const { payload } = await fixture();
  const second = goalGraph(payload, 'second');
  assert.deepEqual(second.nodes.map((node) => node.id), ['second']);
  assert.deepEqual(second.folds.map((fold) => [fold.parent, fold.members.sort()]), [['second', ['helper', 'widget']]]);
  assert.deepEqual(second.edges, [{ from: 'second', to: 'fold:second', type: 'depends_on' }]);
  const needs = needsGraph(payload);
  assert.deepEqual(needs.nodes.map((node) => node.id).sort(), ['cex', 'second', 'side'], 'the counterexample itself waits for the researcher');
  assert.equal(blockingStates(payload).get('second'), 'needs_you');
  assert.equal(defaultGoal(payload), 'second');
});

test('the graph views render', async () => {
  const { payload } = await fixture();
  const noop = () => {};
  const pageProps = { onAction: noop, onNavigate: noop, onShowInResults: noop, onOpenNeeds: noop, onOpenActivity: noop, onOpenPaper: noop };
  const overview = renderToStaticMarkup(React.createElement(OverviewPage, { payload, ...pageProps }));
  assert.match(overview, /The agent is asking you/);
  assert.match(overview, /The agent has a question about Second/);
  assert.match(overview, /Which norm\?/);
  assert.match(overview, /Waiting for you · \d+/);
  assert.match(overview, /See all \d+ →/);
  assert.match(overview, /The paper:.*out of date/);
  assert.match(overview, /class="hero-constellation hc-still"/, 'the agent mark holds still while the agent asks');
  assert.doesNotMatch(overview.replace(/<span class="hero-constellation[^"]*"[\s\S]*?<\/svg><\/span>/, ''), /<svg/, 'the Overview draws no graph beyond the agent mark');
  assert.doesNotMatch(overview, /If you do nothing:/, 'details stay on Needs you');
  assert.equal((overview.match(/Answer…/g) ?? []).length, 1, 'the question’s buttons appear once');
  assert.match(renderToStaticMarkup(React.createElement(OverviewPage, { payload: null, ...pageProps })), /Loading/);
  const needs = renderToStaticMarkup(React.createElement(NeedsYouPage, { payload, onSelect: noop, onAction: noop, onNavigate: noop, onShowInResults: noop, onOpenPaper: noop }));
  assert.match(needs, /Waiting on you now/);
  assert.match(needs, /Holds up a main result/);
  assert.match(needs, /If you do nothing/);
  const counterexample = waitingItems(payload).find((item) => item.category === 'counterexample');
  const chosen = renderToStaticMarkup(React.createElement(NeedsYouPage, { payload, selectedKey: counterexample.key, onSelect: noop, onAction: noop, onNavigate: noop, onShowInResults: noop, onOpenPaper: noop }));
  assert.match(chosen, /Yes, it is a counterexample/);
  assert.match(chosen, /Show in Results/);
  const coverage = renderToStaticMarkup(React.createElement(CoverageMatrix, { payload, onFocus: noop, onAction: noop }));
  assert.match(coverage, /Main result/);
  assert.match(coverage, /out of date/);
  const list = renderToStaticMarkup(React.createElement(ProgressView, { payload, options: DEFAULT_OPTIONS, onOptions: noop, selectedId: 'second', onSelect: noop, onNavigate: noop, onAction: noop }));
  assert.doesNotMatch(list, /<svg/, 'results show as a list by default');
  assert.match(list, /data-result="second"/);
  assert.match(list, /2 finished results/);
  assert.match(list, /Still to do/);
  assert.match(list, /☰ List/);
  assert.match(list, /aria-label="Selected result"/, 'the chosen result opens in the panel next to the list');
  assert.match(list, /A statement\./, 'the panel shows the statement');
  assert.match(list, /What rests on it/);
  assert.match(list, />Open</);
  const graph = renderToStaticMarkup(React.createElement(ProgressView, { payload, options: { ...DEFAULT_OPTIONS, display: 'graph' }, onOptions: noop, selectedId: 'second', onSelect: noop, onNavigate: noop, onAction: noop }));
  assert.match(graph, /<svg/);
  assert.match(graph, /data-node="second"/);
  assert.match(graph, /\+ 1 more · all done/);
  assert.match(graph, /Prerequisites above, main results below/);
  assert.match(graph, /aria-label="Selected result"/, 'the graph uses the same panel');
  assert.doesNotMatch(graph, /Double-click/);
  const everything = renderToStaticMarkup(React.createElement(ProgressView, { payload, options: { ...DEFAULT_OPTIONS, display: 'graph', mode: 'all' }, onOptions: noop, onSelect: noop, onNavigate: noop, onAction: noop }));
  assert.match(everything, /data-node="helper"/);
  assert.match(everything, /4 shown/);
});

test('tracing a result narrows either display to what it rests on, or to what rests on it and the paper', async () => {
  const { payload } = await fixture();
  const noop = () => {};
  assert.deepEqual(traceGraph(payload, 'widget', 'down').nodes.map((node) => node.id).sort(), impactOf(payload, 'widget').downstream.map((node) => node.id).concat('widget').sort());
  assert.ok(traceGraph(payload, 'second', 'up').nodes.some((node) => node.id === 'widget'));
  for (const display of ['graph', 'list']) {
    const html = renderToStaticMarkup(React.createElement(ProgressView, { payload, options: { ...DEFAULT_OPTIONS, display, trace: { id: 'widget', direction: 'down' } }, onOptions: noop, selectedId: 'widget', onSelect: noop, onNavigate: noop, onAction: noop }));
    assert.match(html, /Showing only what rests on <b>[^<]+<\/b>/, display);
    assert.match(html, /Show everything/, display);
    assert.match(html, /In the paper/, display);
    assert.match(html, /main-proof|lines \d/, display);
  }
});

test('with many main results the goal picker stays one compact control, and an all-done project starts from everything', async () => {
  const { payload } = await fixture();
  const noop = () => {};
  const done = { ...payload, required: ['main', 'second', 'helper', 'widget'], nodes: payload.nodes.map((item) => ({ ...item, progress: 'done', inScope: true })) };
  const start = renderToStaticMarkup(React.createElement(ProgressView, { payload: done, options: DEFAULT_OPTIONS, onOptions: noop, onSelect: noop, onNavigate: noop, onAction: noop }));
  assert.match(start, /aria-pressed="true"[^>]*>Everything</, 'nothing is unfinished: start from everything');
  assert.match(start, /data-result="main"/);
  const goal = renderToStaticMarkup(React.createElement(ProgressView, { payload: done, options: { ...DEFAULT_OPTIONS, mode: 'goal' }, onOptions: noop, onSelect: noop, onNavigate: noop, onAction: noop }));
  assert.match(goal, /<select/);
  assert.match(goal, /4 of 4 done/);
  assert.doesNotMatch(goal, /aria-pressed="false"[^>]*>[^<]*<span[^>]*><\/span><span[^>]*>★/, 'no row of goal buttons');
});

test('a result cited from a paper is marked as cited, with where it comes from', () => {
  const files = memoryFiles({
    'research/assets/main.md': node('theorem', { title: 'Main', status: 'draft', deps: ['quoted'] }),
    'research/assets/second.md': node('theorem', { title: 'Second', status: 'draft' }),
    'research/assets/quoted.md': node('lemma', { title: 'Quoted', extra: { source: { kind: 'paper', paper_id: 'smith2021', location: 'Thm 3.2' } } }),
  });
  const payload = buildGraphPayload({ nodes: researchNodes(files), project, projectApproved: true, state: undefined, manuscript: undefined, sectionsDir: 'sections', now: 'now' });
  const byId = new Map(payload.nodes.map((item) => [item.id, item]));
  assert.deepEqual(byId.get('quoted').cited, { kind: 'paper', paper: 'smith2021', location: 'Thm 3.2' });
  assert.deepEqual([byId.get('quoted').progressLabel, byId.get('quoted').progressDetail], ['Cited', 'From smith2021, Thm 3.2']);
  assert.equal(byId.get('main').cited, undefined);
});

test('an unchecked citation reads as not done and waits in "Before you finish", not as a call to act now', () => {
  const files = memoryFiles({
    'research/assets/main.md': node('theorem', { title: 'Main', status: 'draft', deps: ['quoted'] }),
    'research/assets/second.md': node('theorem', { title: 'Second', status: 'draft' }),
    'research/assets/quoted.md': node('lemma', { title: 'Quoted', status: 'draft', extra: { source: { kind: 'paper', paper_id: 'smith2021', location: 'Thm 3.2' } } }),
  });
  const state = { status: 'running', stage: 'plan', current: { assetId: 'main', stageStartedAt: 'now' }, parked: {}, approvalQueue: [{ id: 'c1', kind: 'citation', target: 'quoted', digest: 'd', reason: '', requestedAt: '1' }], answers: [] };
  const payload = buildGraphPayload({ nodes: researchNodes(files), project, projectApproved: true, state, manuscript: undefined, sectionsDir: 'sections', now: 'now' });
  const quoted = payload.nodes.find((item) => item.id === 'quoted');
  assert.deepEqual([quoted.progress, quoted.progressLabel, quoted.progressDetail], ['waiting', 'Not checked', 'From smith2021, Thm 3.2 · check before you finish']);
  const item = payload.attention.find((entry) => entry.key === 'approval:c1');
  assert.equal(item.priority, 3);
  assert.equal(item.title, 'Check the citation for Quoted');
  assert.equal(item.why, 'It is quoted from smith2021, Thm 3.2. Check that the statement matches the source.');
  assert.match(item.ifIgnored, /cannot count as done/);
  assert.equal(payload.health.key, 'working', 'a citation to check is not "your turn"');
});

test('a node under an object search carries the searching flag', () => {
  const files = memoryFiles({ 'research/assets/main.md': node('theorem', { title: 'Main', status: 'draft' }), 'research/assets/second.md': node('theorem', { title: 'Second', status: 'draft' }) });
  const state = { status: 'running', stage: 'search', current: { assetId: 'main', search: { mode: 'refute', round: 1, slots: [] } }, parked: {}, approvalQueue: [] };
  const payload = buildGraphPayload({ nodes: researchNodes(files), project, projectApproved: true, state, manuscript: undefined, sectionsDir: 'sections', now: 'now' });
  const byId = new Map(payload.nodes.map((item) => [item.id, item]));
  assert.deepEqual(byId.get('main').flags, ['active', 'searching']);
  assert.deepEqual(byId.get('second').flags, []);
});

const healthNodes = new Map([
  ['main', { title: 'Main Theorem', type: 'theorem' }],
  ['reduction', { title: 'Reduction', type: 'proposition' }],
  ['key', { title: 'Key bound', type: 'lemma', counts: { failedPlans: 3 } }],
  ['sharp', { title: 'Sharpness example', type: 'construction' }],
]);
const healthEdges = [{ from: 'main', to: 'reduction' }, { from: 'reduction', to: 'key' }];
const loopState = (patch) => ({
  status: 'running', stage: 'search', current: { assetId: 'sharp', stageStartedAt: '2026-10-12T10:00:00Z', search: { mode: 'construct', round: 3, slots: [] } },
  parked: {}, approvalQueue: [], answers: [], updatedAt: '2026-10-12T10:00:00Z', ...patch,
});
const health = (state, now = '2026-10-12T10:05:00Z') => computeLoopHealth({ state, nodes: healthNodes, edges: healthEdges, required: ['main', 'sharp'], now });

test('loop health: a result set aside on a main result’s path while the agent works elsewhere', () => {
  const result = health(loopState({ parked: { key: { reason: 'three_failures', at: '2026-10-12T09:00:00Z' } } }));
  assert.equal(result.key, 'set_aside');
  assert.equal(result.turn, 'agent');
  assert.equal(result.headline, 'Key bound is set aside, and it holds up Main Theorem.');
  assert.match(result.body, /tried 3 different proofs/);
  assert.match(result.body, /Meanwhile the agent is searching for Sharpness example\./);
  assert.deepEqual(result.chain, ['key', 'reduction', 'main']);
  assert.match(result.ifIgnored, /Main Theorem stays unproved/);
  assert.equal(result.statusBar.level, 'warning');
  assert.equal(result.buttons[0].action.action, 'agent');
});

test('loop health: stopped lists each thing the researcher must resolve', () => {
  const state = loopState({
    stage: 'waiting', current: { stageStartedAt: '2026-10-12T10:00:00Z' },
    parked: { key: { reason: 'three_failures', at: '1' }, sharp: { reason: 'search_exhausted', at: '2' } },
    waitingOn: [{ kind: 'parked', target: 'key', detail: 'three_failures' }, { kind: 'missing_definition', target: 'nb_walk', detail: 'reduction' }, { kind: 'parked', target: 'sharp', detail: 'search_exhausted' }],
  });
  const result = health(state);
  assert.equal(result.key, 'stopped');
  assert.equal(result.headline, 'The loop has stopped. 3 things need you before it can continue.');
  assert.deepEqual(result.blockers.map((item) => item.title), [
    'Key bound is set aside after 3 failed proof attempts',
    'The definition “nb walk” is used but never written down',
    'Sharpness example is set aside because its search ran out without a match',
  ]);
  assert.equal(result.blockers[1].detail, 'Reduction uses it; the agent may not invent definitions.');
  assert.equal(result.statusBar.text, 'Research: stopped — 3 things need you');
  assert.equal(result.statusBar.level, 'error');
});

test('loop health: an agent quiet for 20 minutes is reported as stopped, with a way to continue', () => {
  const state = loopState({ stage: 'execute', current: { assetId: 'reduction', stageStartedAt: '2026-10-12T10:00:00Z' } });
  assert.equal(health(state, '2026-10-12T10:10:00Z').key, 'working');
  const result = health(state, '2026-10-12T10:42:00Z');
  assert.equal(result.key, 'stalled');
  assert.equal(result.headline, 'The agent stopped responding 42 min ago.');
  assert.match(result.body, /^It was proving Reduction\./);
  assert.deepEqual(result.chain, ['reduction', 'main']);
  assert.match(result.buttons[0].action.prompt, /research-loop next/);
});

test('loop health: only the agent’s own record says it is working; the extension’s saves do not', () => {
  const at = (time) => `2026-10-12T${time}:00Z`;
  const run = (agent, patch = {}, now = at('10:31')) => computeLoopHealth({ state: loopState({ stage: 'execute', current: { assetId: 'reduction', stageStartedAt: at('10:00') }, updatedAt: at('10:30'), ...patch }), agent, nodes: healthNodes, edges: healthEdges, required: ['main', 'sharp'], now });
  // Without a record (an older driver) a fresh save still reads as work, as before.
  assert.equal(run(undefined).key, 'working');
  // The agent handed back at 10:29; the researcher's edit saved the state at 10:30.
  const ended = run({ turn: 'ended', at: at('10:29'), endedBy: 'stop' });
  assert.equal(ended.key, 'agent_idle');
  assert.equal(ended.tone, 'warning');
  assert.equal(ended.headline, 'No agent is working on the loop right now.');
  assert.match(ended.body, /^The agent ended its turn while proving Reduction\./);
  assert.equal(ended.agentAt, at('10:29'));
  assert.deepEqual(ended.chain, ['reduction', 'main']);
  assert.match(ended.buttons[0].action.prompt, /research-loop next/);
  assert.match(run({ turn: 'ended', at: at('10:29'), endedBy: 'session_end' }).body, /^The agent chat session ended/);
  // In a turn and recently active: working, and the card says when.
  const working = run({ turn: 'open', at: at('10:29') });
  assert.equal(working.key, 'working');
  assert.equal(working.agentAt, at('10:29'));
  // Quiet past the threshold, nothing in flight: it may have stopped (an interrupt leaves no signal).
  const quiet = run({ turn: 'open', at: at('10:24') });
  assert.equal(quiet.key, 'agent_idle');
  assert.equal(quiet.signature, 'agent_idle:quiet');
  // A long command in flight is work, until it is as old as a stall.
  assert.equal(run({ turn: 'open', at: at('10:24'), tool: { name: 'Bash', startedAt: at('10:24') } }).key, 'working');
  // Silent for 20 minutes despite the extension's save at 10:30: stalled.
  assert.equal(run({ turn: 'open', at: at('10:05'), tool: { name: 'Bash', startedAt: at('10:05') } }).key, 'stalled');
});

test('loop health: started or resumed from the dashboard, no agent has picked the loop up', () => {
  const at = (time) => `2026-10-12T${time}:00Z`;
  const run = (agent) => computeLoopHealth({ state: loopState({ runningSince: at('10:20'), updatedAt: at('10:20') }), agent, nodes: healthNodes, edges: healthEdges, required: ['main', 'sharp'], now: at('10:21') });
  const waiting = run(undefined);
  assert.equal(waiting.key, 'agent_idle');
  assert.equal(waiting.headline, 'The loop is on, but no agent has picked it up yet.');
  assert.match(waiting.body, /^Next: searching for Sharpness example\./);
  assert.equal(run({ turn: 'open', at: at('09:00') }).key, 'agent_idle', 'activity from before the resume does not count');
  assert.equal(run({ turn: 'open', at: at('10:20') }).key, 'working');
});

test('no agent working: the current result is not drawn as in progress and the loop leads the attention list', () => {
  const files = memoryFiles({ 'research/assets/main.md': node('theorem', { title: 'Main', status: 'draft' }), 'research/assets/second.md': node('theorem', { title: 'Second', status: 'draft' }) });
  const state = { status: 'running', stage: 'search', current: { assetId: 'main', stageStartedAt: '2026-10-12T10:00:00Z', search: { mode: 'refute', round: 1, slots: [] } }, parked: {}, approvalQueue: [], answers: [], updatedAt: '2026-10-12T10:00:00Z' };
  const payload = buildGraphPayload({ nodes: researchNodes(files), project, projectApproved: true, state, agent: { turn: 'ended', at: '2026-10-12T10:01:00Z', endedBy: 'stop' }, manuscript: undefined, sectionsDir: 'sections', now: '2026-10-12T10:02:00Z' });
  assert.equal(payload.health.key, 'agent_idle');
  const main = payload.nodes.find((item) => item.id === 'main');
  assert.deepEqual(main.flags, []);
  assert.equal(main.progressLabel, 'No agent working');
  assert.equal(payload.attention[0].key, 'loop:agent_idle');
});

test('loop health: a review on the main path, a pause at the continuation limit, and plain work', () => {
  const review = health(loopState({ approvalQueue: [{ id: 'r1', kind: 'asset', target: 'key', digest: 'd', reason: '', requestedAt: '1' }] }));
  assert.equal(review.key, 'needs_you');
  assert.equal(review.headline, 'Review the proof of Key bound.');
  assert.deepEqual(review.buttons.map((button) => button.label), ['Read the proof', 'Accept proof', 'Ask for changes…']);
  const paused = health(loopState({ status: 'paused', lastError: 'Autopilot stopped after 30 automatic continuations in this session.' }));
  assert.equal(paused.key, 'paused');
  assert.match(paused.body, /30 automatic continuations/);
  const working = health(loopState({}));
  assert.equal(working.headline, 'Searching for Sharpness example.');
  assert.equal(working.ifIgnored, 'Nothing is needed from you right now.');
  assert.equal(health(undefined).key, 'idle');
});

test('the timeline tells loop events in words, newest first', () => {
  const title = (id) => healthNodes.get(id)?.title ?? id;
  const lines = buildHistory([
    { at: '1', type: 'stage', stage: 'select' },
    { at: '2', type: 'report', outcome: 'failed', summary: 'Attempt 3 failed: the moment estimate loses a log factor.' },
    { at: '3', type: 'parked', assetId: 'key', reason: 'three_failures' },
    { at: '4', type: 'stage', stage: 'waiting' },
  ], title);
  assert.deepEqual(lines.map((line) => [line.text, line.tone]), [
    ['Stopped: nothing left that the agent can work on.', 'error'],
    ['Set Key bound aside after repeated failed proof attempts.', 'error'],
    ['Attempt 3 failed: the moment estimate loses a log factor.', 'warning'],
  ]);
});

test('text for the researcher: the loop’s vocabulary draws a reminder, mathematics does not', () => {
  const { internalVocabulary, vocabularyReminder } = load('../src/domain/researcherText.ts');
  assert.deepEqual(internalVocabulary('Slot 1 found no plausible counterexample; no candidates written.'), ['search slot numbers', 'loop internals (workers, packs, candidate files)']);
  assert.deepEqual(internalVocabulary('It depends on lib_arf_surgery_construction_v4 in arf_cusp.md.'), ['file names', 'IDs (use the result’s title)']);
  assert.deepEqual(internalVocabulary('No counterexample in this round: zero curvature violates (A2), and $x_1 \\le \\epsilon_{neck}$ fails.'), []);
  assert.deepEqual(internalVocabulary('The estimate fails for x_1 near the cap.'), [], 'a subscript is not an ID');
  assert.equal(vocabularyReminder('Proved the gradient bound.'), '');
  assert.match(vocabularyReminder('Worker 2 wrote `cand_x.md`.'), /Writing for the researcher/);
});
