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
const { visibleGraph, transitiveReduction, impactOf, DEFAULT_OPTIONS, MAX_VISIBLE } = load('../webview-src/graph/graphModel.ts');
const { layout, laneOrder } = load('../webview-src/graph/layout.ts');
const views = load('../webview-src/graph/GraphTab.tsx', ['react']);
const { CoverageMatrix } = load('../webview-src/graph/CoverageMatrix.tsx', ['react']);
const { ImpactView } = load('../webview-src/graph/ImpactView.tsx', ['react']);
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

test('attention: blocking questions and counterexamples first, then critical reviews, then stuck work, then the rest', async () => {
  const { payload } = await fixture();
  assert.deepEqual(payload.attention.map((item) => `${item.priority}:${item.key}`), [
    '0:question:q1', '0:approval:r3', '1:approval:r1', '2:parked:side', '2:section:sec_main', '3:approval:r2', '3:section:sec_new',
  ]);
  const counterexample = payload.attention[1];
  assert.match(counterexample.title, /counterexample cex to second/);
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

test('layout puts prerequisites left of their dependants and shared prerequisites in the top band', async () => {
  const { payload } = await fixture();
  const visible = visibleGraph(payload, { ...DEFAULT_OPTIONS, showDefinitions: true });
  const placed = layout(visible.nodes, visible.edges, payload.required);
  const x = (id) => placed.positions.get(id).x;
  assert.ok(x('widget') < x('helper') && x('helper') < x('main') && x('helper') < x('second'));
  assert.deepEqual(laneOrder(visible.nodes, payload.required), ['shared', 'main', 'second', 'other']);
  assert.equal(placed.bands[0].lane, 'shared');
  const boxes = [...placed.positions.values()];
  for (const a of boxes) for (const b of boxes) if (a !== b) assert.ok(a.x !== b.x || Math.abs(a.y - b.y) >= 56, `${a.id} overlaps ${b.id}`);
});

test('the graph views render', async () => {
  const { payload } = await fixture();
  const noop = () => {};
  const tab = renderToStaticMarkup(React.createElement(views.GraphTab, { payload, onAction: noop, onNavigate: noop }));
  assert.match(tab, /Attention \(7\)/);
  assert.match(tab, /Which norm\?/);
  assert.match(tab, /Confirm counterexample/);
  assert.match(tab, /Update in chat ↗/);
  assert.match(tab, /Manuscript:.*stale/);
  assert.match(renderToStaticMarkup(React.createElement(views.GraphTab, { payload: null, onAction: noop, onNavigate: noop })), /Loading/);
  const coverage = renderToStaticMarkup(React.createElement(CoverageMatrix, { payload, onFocus: noop, onAction: noop }));
  assert.match(coverage, /Main result/);
  assert.match(coverage, /stale/);
  const impact = renderToStaticMarkup(React.createElement(ImpactView, { payload, selectedId: 'widget', onSelect: noop, onNavigate: noop, onAction: noop }));
  assert.match(impact, /Manuscript impact/);
  assert.match(impact, /main-proof/);
  const progress = renderToStaticMarkup(React.createElement(ProgressView, { payload, options: DEFAULT_OPTIONS, onOptions: noop, selectedId: 'main', onSelect: noop, onImpact: noop, onNavigate: noop, onAction: noop }));
  assert.match(progress, /<svg/);
  assert.match(progress, /data-node="helper"/);
  assert.match(progress, /1 implied edges omitted|4 shown/);
});

test('a node under an object search carries the searching flag', () => {
  const files = memoryFiles({ 'research/assets/main.md': node('theorem', { title: 'Main', status: 'draft' }), 'research/assets/second.md': node('theorem', { title: 'Second', status: 'draft' }) });
  const state = { status: 'running', stage: 'search', current: { assetId: 'main', search: { mode: 'refute', round: 1, slots: [] } }, parked: {}, approvalQueue: [] };
  const payload = buildGraphPayload({ nodes: researchNodes(files), project, projectApproved: true, state, manuscript: undefined, sectionsDir: 'sections', now: 'now' });
  const byId = new Map(payload.nodes.map((item) => [item.id, item]));
  assert.deepEqual(byId.get('main').flags, ['active', 'searching']);
  assert.deepEqual(byId.get('second').flags, []);
});
