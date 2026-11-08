const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
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

const { parseCollectionMeta, summarizeCollection, planCollectionRemove } = load('../src/domain/collections.ts');
const { PackageActions } = load('../src/services/PackageActions.ts');
const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { NodeLoopFiles, loadProjectPaths } = load('../src/cli/nodeFiles.ts');
const { LibraryBar } = load('../webview-src/components/LibraryBar.tsx', ['react']);
const { CheckBar, needsCheck, nextToCheck, uncheckedIn } = load('../webview-src/components/CheckBar.tsx', ['react']);

const LIB = 'research/library';
const node = (id, status, source, extra = {}) => ({ id, file: `${LIB}/smith/assets/${id}.md`, kind: 'asset', title: id, status, ...(source ? { source } : {}), ...extra });
const smith = (location = 'Theorem 1') => ({ kind: 'paper', paper_id: 'smith2021', location });

// ---------- domain ----------

test('collection.md says where a collection comes from; an old one without frontmatter still gives its title', () => {
  const { meta, problems } = parseCollectionMeta('---\ntitle: Smith, Rigidity\nkind: paper\npaper_id: smith2021\n---\n\nThe main results of Smith 2021.\n');
  assert.deepEqual(problems, []);
  assert.deepEqual(meta, { title: 'Smith, Rigidity', kind: 'paper', paper_id: 'smith2021', description: 'The main results of Smith 2021.' });
  assert.deepEqual(parseCollectionMeta('# My thesis\n\nChapters 2 and 3.\n').meta, { title: 'My thesis', description: 'Chapters 2 and 3.' });
  assert.match(parseCollectionMeta('---\nkind: book\n---\n', 'c.md').problems.join('\n'), /c\.md: kind must be one of paper, note, thesis, other/);
});

test('a paper collection holds every result to its paper; without a declared kind, one cited paper makes it that paper', () => {
  const declared = '---\nkind: paper\npaper_id: smith2021\n---\n';
  const ok = summarizeCollection('smith', declared, [node('lib_a', 'approved', smith()), node('lib_b', 'draft', smith('Lemma 2'))], { library: LIB, paperIds: new Set(['smith2021']) });
  assert.deepEqual([ok.kind, ok.declared, ok.paperId, ok.results, ok.approved, ok.drafts, ok.problems], ['paper', true, 'smith2021', 2, 1, ['lib_b'], []]);

  const wrong = summarizeCollection('smith', declared, [node('lib_a', 'draft', { kind: 'paper', paper_id: 'jones2019', location: 'p. 3' }), node('lib_b', 'draft', { kind: 'original' })], { library: LIB, paperIds: new Set(['smith2021']) });
  assert.match(wrong.problems.join('\n'), /lib_a\.md: collection smith is from paper smith2021, but this result cites jones2019/);
  assert.match(wrong.problems.join('\n'), /lib_b\.md: collection smith is from paper smith2021; cite it/);

  assert.match(summarizeCollection('smith', '---\nkind: paper\n---\n', [], { library: LIB }).problems.join('\n'), /add paper_id/);
  assert.match(summarizeCollection('smith', declared, [], { library: LIB, paperIds: new Set() }).problems.join('\n'), /paper_id smith2021 is not in the paper index/);

  const inferred = summarizeCollection('smith', undefined, [node('lib_a', 'draft', smith())], { library: LIB });
  assert.deepEqual([inferred.kind, inferred.declared, inferred.paperId, inferred.problems], ['paper', false, 'smith2021', []]);
  const mixed = summarizeCollection('notes', '# Notes\n', [node('lib_a', 'draft', smith()), node('lib_b', 'draft', { kind: 'original' })], { library: LIB });
  assert.deepEqual([mixed.kind, mixed.title, mixed.paperId], ['other', 'Notes', undefined]);
});

test('removing a collection deletes its results and records, keeps its paper, and stops while a result is in use', () => {
  const nodes = [node('lib_a', 'approved', smith()), node('lib_b', 'draft', smith())];
  const blocked = planCollectionRemove({ name: 'smith', paperId: 'smith2021' }, nodes, { references: new Map([['lib_a', ['main_theorem']]]) });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.conflicts, ['lib_a is still used by main_theorem.']);
  const plan = planCollectionRemove({ name: 'smith', paperId: 'smith2021' }, nodes, { references: new Map(), metaFile: `${LIB}/smith/collection.md`, approvalFiles: ['research/approvals/assets/lib_a.json'] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.deletes, [`${LIB}/smith/assets/lib_a.md`, `${LIB}/smith/assets/lib_b.md`, `${LIB}/smith/collection.md`, 'research/approvals/assets/lib_a.json']);
  assert.match(plan.warnings.join('\n'), /smith2021 stays in Papers/);
});

// ---------- on disk ----------

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n---\n\n# Project\n\n## Main Problem\n\nX.\n\n## Scope and Assumptions\n\nY.\n\n## Intended Contribution\n\nZ.\n\n## Background\n\nW.\n';
const result = (data, body = '## Statement\n\nA statement.\n') => matter.stringify(`\n${body}`, { tags: [], depends_on: [], uses_definitions: [], ...data });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-collections-'));
  write(root, '.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared' }));
  write(root, 'main.tex', '\\documentclass{article}\\begin{document}x\\end{document}\n');
  write(root, 'research/project.md', project);
  write(root, 'references.bib', '@article{smith2021,\n  title = {Rigidity of {C}ollapsing Manifolds},\n  author = {Smith, A.},\n  year = {2021}\n}\n');
  write(root, 'research/papers.md', '# Papers\n\n## smith2021\n\nSmith on rigidity.\n');
  write(root, `${LIB}/smith/collection.md`, '---\ntitle: Smith 2021\nkind: paper\npaper_id: smith2021\n---\n\nThe results of Smith 2021.\n');
  write(root, `${LIB}/smith/assets/lib_smith_rigidity.md`, result({ type: 'theorem', title: 'Rigidity', status: 'approved', source: { kind: 'paper', paper_id: 'smith2021', location: 'Theorem 1.1' } }));
  write(root, `${LIB}/smith/assets/lib_smith_lemma.md`, result({ type: 'lemma', title: 'Key lemma', status: 'draft', source: { kind: 'paper', paper_id: 'smith2021', location: 'Lemma 2.3' } }));
  write(root, 'research/approvals/assets/lib_smith_rigidity.json', '{}');
  write(root, 'research/assets/main_theorem.md', result({ type: 'theorem', title: 'Main', status: 'draft', source: { kind: 'original' }, depends_on: ['lib_smith_rigidity'] }, '## Statement\n\nX.\n\n## Proof\n\nY.\n'));
  return root;
}

async function actionsFor(root) {
  const paths = await loadProjectPaths(root);
  const files = new NodeLoopFiles(root);
  const core = new ResearchLoopCore(files, paths, { id: () => Math.random().toString(36).slice(2), iterationCap: 5 });
  const withCore = async (action) => { await core.load(); return action(core); };
  return { core, actions: new PackageActions(files, paths, root, withCore, 'test') };
}

test('the Library overview lists paper collections with their paper, counts, and problems; validation reports them', async () => {
  const root = fixture();
  try {
    const { core, actions } = await actionsFor(root);
    const [smithView] = (await actions.overview()).collections;
    assert.deepEqual(
      [smithView.name, smithView.kind, smithView.paperId, smithView.paperTitle, smithView.paperIndexed, smithView.results, smithView.approved, smithView.drafts, smithView.problems],
      ['smith', 'paper', 'smith2021', 'Rigidity of Collapsing Manifolds', true, 2, 1, ['lib_smith_lemma'], []],
    );
    assert.equal((await core.validateAll()).some((problem) => /collection smith/.test(problem)), false);

    // A result citing another paper in Smith's collection is reported on the card and by validation.
    write(root, 'references.bib', `${fs.readFileSync(path.join(root, 'references.bib'), 'utf8')}@article{jones2019,\n  title = {Other},\n  year = {2019}\n}\n`);
    write(root, 'research/papers.md', '# Papers\n\n## smith2021\n\nSmith.\n\n## jones2019\n\nJones.\n');
    write(root, `${LIB}/smith/assets/lib_smith_other.md`, result({ type: 'lemma', title: 'Other', status: 'draft', source: { kind: 'paper', paper_id: 'jones2019', location: 'Lemma 1' } }));
    const problem = /lib_smith_other\.md: collection smith is from paper smith2021, but this result cites jones2019/;
    assert.match((await actions.overview()).collections[0].problems.join('\n'), problem);
    assert.match((await core.validateAll()).join('\n'), problem);

    // An imported package is not listed as a collection.
    write(root, `${LIB}/pkg/package.lock.json`, JSON.stringify({ lockVersion: 1, package: 'pkg', alias: 'pkg', version: '1.0.0', source: { type: 'file', path: '../pkg.rpkg.json' }, nodes: {} }));
    assert.deepEqual((await actions.overview()).collections.map((item) => item.name), ['smith']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a collection is removed with its records and folders once nothing uses it, and its paper stays', async () => {
  const root = fixture();
  try {
    const { actions } = await actionsFor(root);
    const blocked = await actions.previewRemoveCollection('smith');
    assert.deepEqual(blocked.conflicts, ['lib_smith_rigidity is still used by main_theorem.']);
    await assert.rejects(actions.removeCollection('smith'), /still used by main_theorem/);

    write(root, 'research/assets/main_theorem.md', result({ type: 'theorem', title: 'Main', status: 'draft', source: { kind: 'original' } }, '## Statement\n\nX.\n\n## Proof\n\nY.\n'));
    const plan = await actions.previewRemoveCollection('smith');
    assert.equal(plan.ok, true);
    assert.ok(plan.deletes.includes('research/approvals/assets/lib_smith_rigidity.json'));
    await actions.removeCollection('smith');
    assert.equal(fs.existsSync(path.join(root, `${LIB}/smith`)), false);
    assert.equal(fs.existsSync(path.join(root, 'research/approvals/assets/lib_smith_rigidity.json')), false);
    assert.match(fs.readFileSync(path.join(root, 'research/papers.md'), 'utf8'), /## smith2021/);
    assert.match(fs.readFileSync(path.join(root, 'references.bib'), 'utf8'), /@article\{smith2021,/);
    assert.deepEqual((await actions.overview()).collections, []);
    await assert.rejects(actions.previewRemoveCollection('smith'), /No collection named smith/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- components ----------

const noop = () => {};
const barActions = { onSelect: noop, onImport: noop, onExport: noop, onAccept: noop, onUpdate: noop, onRemove: noop, onCheck: noop, onOpenPaper: noop, onRemoveCollection: noop };
const view = (extra) => ({ name: 'smith', kind: 'paper', declared: true, paperId: 'smith2021', paperTitle: 'Rigidity', paperIndexed: true, results: 5, approved: 2, drafts: ['lib_a', 'lib_b', 'lib_c'], problems: [], ...extra });

test('the library bar shows packages and paper collections as cards in two groups', () => {
  const html = renderToStaticMarkup(React.createElement(LibraryBar, {
    data: { library: LIB, installed: [{ alias: 'hk', package: 'hk', version: '1.0.0', results: 2, pending: 0, accepted: true, source: '../a', problems: [] }], collections: [view(), view({ name: 'thesis', kind: 'thesis', declared: false, paperId: undefined, paperTitle: undefined, paperIndexed: undefined, title: 'My thesis', drafts: [], approved: 5 })] },
    selected: 'smith', ...barActions,
  }));
  assert.ok(html.indexOf('Packages') < html.indexOf('hk') && html.indexOf('hk') < html.indexOf('From papers &amp; notes') && html.indexOf('From papers &amp; notes') < html.indexOf('smith'));
  assert.match(html, /3 TO CHECK/);
  assert.match(html, /5 results \(2 checked\) · Rigidity/);
  assert.match(html, />Check 3 results…</);
  assert.equal((html.match(/>Open paper</g) ?? []).length, 1, 'only a collection with an indexed paper opens one');
  assert.match(html, /✓ CHECKED/);
  assert.match(html, /My thesis/);
  assert.match(html, /aria-pressed="true"[^>]*>[^]*?smith/, 'the chosen collection is marked');
  assert.equal((html.match(/>Remove…</g) ?? []).length, 3);
  const empty = renderToStaticMarkup(React.createElement(LibraryBar, { data: { library: LIB, installed: [], collections: [] }, ...barActions }));
  assert.match(empty, /Ask the agent to extract the results of a paper/);
});

test('the check bar points at the place in the source, and checking moves through the collection in order', () => {
  const lib = (id, order, status = 'draft', collection = 'smith', source = smith(`Lemma ${order}`)) => ({ id, type: 'lemma', title: id, status, tags: [], filePath: `${LIB}/${collection}/assets/${id}.md`, body: '', origin: 'library', collection, order, source, depends_on: [], uses_definitions: [], related_assets: [] });
  const nodes = [lib('lib_c', 3), lib('lib_a', 1), lib('lib_b', 2, 'approved'), lib('lib_d', 4), lib('lib_p', 1, 'draft', 'pkg'), { id: 'main', type: 'theorem', title: 'Main', status: 'draft', tags: [], filePath: 'research/assets/main.md', body: '' }];
  assert.deepEqual(uncheckedIn(nodes, 'smith').map((item) => item.id), ['lib_a', 'lib_c', 'lib_d']);
  assert.equal(nextToCheck(nodes, 'smith', 'lib_a').id, 'lib_c');
  assert.equal(nextToCheck(nodes, 'smith', 'lib_d').id, 'lib_a', 'wraps around');
  assert.equal(nextToCheck(nodes, 'smith', 'lib_a', new Set(['lib_c'])).id, 'lib_d', 'skipped ones are left out');
  assert.equal(nextToCheck(nodes, 'smith', 'lib_a', new Set(['lib_c', 'lib_d'])), undefined);
  const packages = new Set(['pkg']);
  assert.equal(needsCheck(nodes[1], packages), true);
  assert.equal(needsCheck(nodes[2], packages), false, 'checked already');
  assert.equal(needsCheck(nodes[4], packages), false, 'an imported package is accepted as a whole');
  assert.equal(needsCheck(nodes[5], packages), false, 'a project result is not a known result');

  const html = renderToStaticMarkup(React.createElement(CheckBar, { node: nodes[1], remaining: 3, reviewing: true, onCheck: noop, onSkip: noop, onStop: noop, onOpenPaper: noop }));
  assert.match(html, /<strong>smith2021<\/strong>, Lemma 1/);
  assert.match(html, /3 left in smith/);
  assert.match(html, />✓ Matches the source</);
  assert.match(html, />Open paper</);
  assert.match(html, />Skip</);
  assert.match(html, />Stop</);
  const missing = renderToStaticMarkup(React.createElement(CheckBar, { node: lib('lib_x', 1, 'draft', 'smith', { kind: 'paper', paper_id: 'smith2021' }), remaining: 1, reviewing: false, onCheck: noop, onSkip: noop, onStop: noop, onOpenPaper: noop }));
  assert.match(missing, /<button disabled=""[^>]*>✓ Matches the source/);
  assert.match(missing, /exact location under Source/);
  assert.doesNotMatch(missing, />Skip</);
});
