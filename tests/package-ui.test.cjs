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

const { PackageActions } = load('../src/services/PackageActions.ts');
const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { NodeLoopFiles, loadProjectPaths } = load('../src/cli/nodeFiles.ts');
const { approvalDigest } = load('../src/services/ResearchLoopModel.ts');
const { PackageBar } = load('../webview-src/components/PackageBar.tsx', ['react']);
const { ImportPackageModal } = load('../webview-src/components/ImportPackageModal.tsx', ['react']);
const { ExportPackageModal } = load('../webview-src/components/ExportPackageModal.tsx', ['react']);

const project = (id) => `---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: ${id}\n---\n\n# Project\n\n## Main Problem\n\nX.\n\n## Scope and Assumptions\n\nY.\n\n## Intended Contribution\n\nZ.\n\n## Background\n\nW.\n`;

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function approvedNode(root, kind, file, data, body) {
  const raw = matter.stringify(`\n${body}`, { ...data, status: 'approved', tags: [] });
  write(root, file, raw);
  const id = path.basename(file, '.md');
  write(root, `research/approvals/${kind === 'asset' ? 'assets' : 'definitions'}/${id}.json`, JSON.stringify({ kind, target: id, digest: approvalDigest(raw, kind), approvedAt: '2026-11-01T00:00:00Z', performed_by: 'alice@example.edu' }));
}

/** Two projects on disk: paperA to export, paperB to import into. */
function projects() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-packages-'));
  const up = path.join(base, 'paperA');
  const down = path.join(base, 'paperB');
  for (const root of [up, down]) {
    write(root, '.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared' }));
    write(root, 'main.tex', '\\documentclass{article}\\begin{document}x\\end{document}\n');
  }
  write(up, 'research/project.md', project('main_theorem'));
  write(up, 'references.bib', '% refs\n');
  write(up, 'research/package/citation.bib', '@unpublished{wang2026heat,\n  title = {Heat kernel bounds},\n  author = {Wang, Xiaokang},\n  year = {2026},\n  url = {https://arxiv.org/abs/2611.00001}\n}\n');
  write(up, 'research/papers.md', '# Papers\n\n## wang2026heat\n\nThis work.\n- URL: https://arxiv.org/abs/2611.00001\n');
  approvedNode(up, 'definition', 'research/definitions/heat_kernel_def.md', { type: 'definition', title: 'Definition (heat kernel)', source: { kind: 'original' }, depends_on: [] }, '## Statement\n\nThe heat kernel.\n');
  approvedNode(up, 'asset', 'research/assets/main_theorem.md', { type: 'theorem', title: 'Main theorem', source: { kind: 'original' }, depends_on: [], uses_definitions: ['heat_kernel_def'] }, '## Statement\n\nDecay.\n\n## Proof\n\nDone.\n');
  write(up, 'research/assets/draft_lemma.md', matter.stringify('\n## Statement\n\nLater.\n', { type: 'lemma', title: 'Draft lemma', status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [] }));
  write(down, 'research/project.md', project('my_result'));
  write(down, 'references.bib', '% refs\n');
  write(down, 'research/papers.md', '# Papers\n');
  return { base, up, down };
}

async function actionsFor(root) {
  const paths = await loadProjectPaths(root);
  const files = new NodeLoopFiles(root);
  const core = new ResearchLoopCore(files, paths, { id: () => Math.random().toString(36).slice(2), iterationCap: 5 });
  const withCore = async (action) => { await core.load(); return action(core); };
  return { core, actions: new PackageActions(files, paths, root, withCore, 'test') };
}

test('the dashboard actions export, import, accept, update, and remove a package on disk', async () => {
  const { up, down, base } = projects();
  try {
    const A = await actionsFor(up);
    // The first preview has no manifest; the candidates list the project's results, goals first.
    let preview = await A.actions.previewExport({});
    assert.equal(preview.ok, false);
    assert.match(preview.blockers.join('\n'), /No package name yet/);
    assert.deepEqual(preview.candidates.map((item) => [item.id, item.required, item.approved]), [['main_theorem', true, true], ['draft_lemma', false, false]]);
    assert.match(preview.citation, /@unpublished\{wang2026heat,/);
    assert.equal(preview.citationSaved, true);
    preview = await A.actions.previewExport({ name: 'heat_kernel', locations: { main_theorem: 'Theorem 1.2' } });
    assert.equal(preview.ok, true);
    assert.deepEqual([preview.version, preview.bump, preview.closure.length], ['1.0.0', 'initial', 2]);
    assert.match((await A.actions.previewExport({ name: 'heat_kernel', exports: ['main_theorem', 'draft_lemma'] })).blockers.join('\n'), /draft_lemma: not approved/);
    assert.equal(await A.actions.exportFileName({ name: 'heat_kernel' }), 'heat_kernel-1.0.0.rpkg.json');

    const exported = await A.actions.export({ name: 'heat_kernel', locations: { main_theorem: 'Theorem 1.2' } });
    assert.equal(exported.recorded, true);
    const file = path.join(base, exported.fileName);
    fs.writeFileSync(file, exported.text);
    assert.equal((await A.actions.overview()).released, '1.0.0');
    assert.equal((await A.actions.overview()).manifest.locations.main_theorem, 'Theorem 1.2');

    const B = await actionsFor(down);
    const imported = await B.actions.previewImport(file, 'hk');
    assert.equal(imported.ok, true);
    assert.equal(imported.source, file);
    assert.deepEqual(imported.nodes.map((node) => node.id), ['lib_hk_heat_kernel_def', 'lib_hk_main_theorem']);
    assert.equal((await B.actions.previewImport(file, 'Bad')).ok, false);
    const result = await B.actions.import(file, 'hk');
    assert.match(result.message, /Imported heat_kernel 1\.0\.0 as hk \(2 results\)/);
    let overview = await B.actions.overview();
    assert.deepEqual(overview.installed.map((item) => [item.alias, item.version, item.pending, item.accepted, item.problems.length]), [['hk', '1.0.0', 2, false, 0]]);
    assert.equal(overview.installed[0].source, path.relative(down, file));

    await B.actions.approve('hk', 'dashboard');
    overview = await B.actions.overview();
    assert.equal(overview.installed[0].accepted, true);

    // Update from the recorded source: nothing changed upstream.
    assert.equal(await B.actions.updateSource('hk'), path.relative(down, file));
    const update = await B.actions.previewImport(await B.actions.updateSource('hk'), undefined, 'hk');
    assert.deepEqual([update.update, update.diff.bump], ['hk', 'none']);
    // Update from the project folder after a proof change upstream: only that result re-opens.
    const theorem = path.join(up, 'research/assets/main_theorem.md');
    fs.writeFileSync(theorem, fs.readFileSync(theorem, 'utf8').replace('Done.', 'Done, directly.'));
    approvedNode(up, 'asset', 'research/assets/main_theorem.md', matter(fs.readFileSync(theorem, 'utf8')).data, matter(fs.readFileSync(theorem, 'utf8')).content.trim() + '\n');
    const fromFolder = await B.actions.previewImport(up, undefined, 'hk');
    assert.deepEqual([fromFolder.version, fromFolder.diff.bump, fromFolder.diff.proof], ['1.0.1-dev', 'patch', ['lib_hk_main_theorem']]);
    const updated = await B.actions.import(up, undefined, 'hk');
    assert.match(updated.message, /Updated hk to heat_kernel 1\.0\.1-dev\. Approvals affected: lib_hk_main_theorem/);
    overview = await B.actions.overview();
    assert.deepEqual([overview.installed[0].pending, overview.installed[0].approvedVersion], [1, '1.0.0']);

    // Changing packages waits while a loop stage runs.
    await B.core.start('claude', { goal: 'x' });
    await assert.rejects(B.actions.remove('hk'), /Pause the loop first/);
    await B.core.pause();

    const removal = await B.actions.previewRemove('hk');
    assert.equal(removal.ok, true);
    await B.actions.remove('hk');
    assert.deepEqual((await B.actions.overview()).installed, []);
    const left = fs.existsSync(path.join(down, 'research/library/hk')) ? fs.readdirSync(path.join(down, 'research/library/hk'), { recursive: true }).filter((entry) => /\.(md|json)$/.test(entry)) : [];
    assert.deepEqual(left, []);
    assert.equal(fs.existsSync(path.join(down, 'research/approvals/packages/hk.json')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------- components ----------

const noop = () => {};

test('the package bar shows each package with its state and actions', () => {
  const html = renderToStaticMarkup(React.createElement(PackageBar, {
    data: { library: 'research/library', released: '1.2.0', installed: [
      { alias: 'hk', package: 'heat_kernel', version: '1.0.1', results: 4, pending: 1, accepted: false, approvedVersion: '1.0.0', source: '../a.rpkg.json', problems: [] },
      { alias: 'old', package: 'old_work', version: '2.0.0', results: 2, pending: 0, accepted: true, source: '../b', problems: ['research/library/old/assets/lib_old_x.md: edited after import'] },
    ] },
    onImport: noop, onExport: noop, onAccept: noop, onUpdate: noop, onRemove: noop,
  }));
  assert.match(html, />Import a package…</);
  assert.match(html, />Export this project…</);
  assert.match(html, /latest release: v1\.2\.0/);
  assert.match(html, /heat_kernel<\/span><span[^>]*>v1\.0\.1/);
  assert.match(html, /v1\.0\.0 accepted earlier/);
  assert.match(html, />Update…</);
  assert.match(html, />Remove…</);
  assert.match(html, /1 TO REVIEW/);
  assert.match(html, /✓ ACCEPTED/);
  assert.match(html, /edited after import/);
  // Accept shows only for a package that waits and matches its lockfile.
  assert.equal((html.match(/>Accept package</g) ?? []).length, 1);
  // The package name shows only when the alias differs from it.
  const same = renderToStaticMarkup(React.createElement(PackageBar, {
    data: { library: 'research/library', installed: [{ alias: 'collapsing_lcf', package: 'collapsing_lcf', version: '1.0.0', results: 3, pending: 0, accepted: true, source: '../c.rpkg.json', problems: [] }] },
    onImport: noop, onExport: noop, onAccept: noop, onUpdate: noop, onRemove: noop,
  }));
  assert.equal((same.match(/collapsing_lcf</g) ?? []).length, 1);
  assert.match(renderToStaticMarkup(React.createElement(PackageBar, { data: { library: 'research/library', installed: [] }, onImport: noop, onExport: noop, onAccept: noop, onUpdate: noop, onRemove: noop })), /No packages imported/);
});

test('the import dialog shows what an import or update would write, and blocks on conflicts', () => {
  const preview = {
    ok: true, source: '/x/heat.rpkg.json', name: 'heat_kernel', version: '1.0.0', alias: 'heat_kernel',
    nodes: [{ id: 'lib_heat_kernel_main', upstream: 'main', kind: 'asset', title: 'Main theorem' }],
    bibChanges: [{ key: 'wang', as: 'wang_heat_kernel', action: 'renamed' }, { key: 'li', as: 'li_yau', action: 'reused' }],
    conflicts: [], warnings: ['main: the package records no upstream approval.'],
  };
  const empty = renderToStaticMarkup(React.createElement(ImportPackageModal, { busy: false, onPick: noop, onSource: noop, onAlias: noop, onConfirm: noop, onCancel: noop }));
  assert.match(empty, /Import a research package/);
  assert.match(empty, /A package file \(\.rpkg\.json\)…/);
  assert.match(empty, /disabled=""[^>]*>Import</);

  const html = renderToStaticMarkup(React.createElement(ImportPackageModal, { preview, busy: false, onPick: noop, onSource: noop, onAlias: noop, onConfirm: noop, onCancel: noop }));
  assert.match(html, /heat_kernel 1\.0\.0 · from \/x\/heat\.rpkg\.json/);
  assert.match(html, /lib_heat_kernel_…/);
  assert.match(html, /Results and definitions \(1\)/);
  assert.match(html, /the key is taken by another work here/);
  assert.match(html, /already in the bibliography/);
  assert.match(html, /records no upstream approval/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Import</);

  const blocked = renderToStaticMarkup(React.createElement(ImportPackageModal, { preview: { ...preview, ok: false, conflicts: ['Package heat_kernel is already imported as hk; use package update hk.'] }, busy: false, onPick: noop, onSource: noop, onAlias: noop, onConfirm: noop, onCancel: noop }));
  assert.match(blocked, /Conflicts \(fix these first\)/);
  assert.match(blocked, /disabled=""[^>]*>Import</);

  const update = renderToStaticMarkup(React.createElement(ImportPackageModal, {
    update: 'hk', preview: { ...preview, update: 'hk', diff: { from: '1.0.0', to: '2.0.0', added: [], removed: [], statement: ['lib_hk_main'], proof: [], bump: 'major' } },
    busy: false, onPick: noop, onSource: noop, onAlias: noop, onConfirm: noop, onCancel: noop,
  }));
  assert.match(update, /Update hk/);
  assert.match(update, /1\.0\.0 → 2\.0\.0: <strong>major<\/strong>/);
  assert.match(update, /statement changed: <code>lib_hk_main<\/code>/);
  assert.doesNotMatch(update, /Alias/);
});

test('the export dialog fills from the saved manifest and shows blockers, version, and contents', () => {
  const preview = {
    ok: false, blockers: ['draft_lemma: not approved.'], warnings: [], manifest: { name: 'heat_kernel', locations: { main_theorem: 'Theorem 1.2' } },
    exports: ['main_theorem'], closure: [{ id: 'main_theorem', kind: 'asset', title: 'Main theorem', origin: 'project' }, { id: 'lib_li_yau', kind: 'asset', title: 'Li-Yau', origin: 'library' }],
    version: '1.1.0', previous: '1.0.0', bump: 'minor', changes: { added: ['lib_li_yau'], removed: [], statement: [], proof: [], exportsAdded: [], exportsRemoved: [] }, unchanged: false,
    candidates: [{ id: 'main_theorem', title: 'Main theorem', approved: true, required: true }, { id: 'draft_lemma', title: 'Draft lemma', approved: false, required: false }],
    citation: '@unpublished{wang2026heat,\n  title = {Heat kernel bounds}\n}\n', citationSaved: false,
  };
  const html = renderToStaticMarkup(React.createElement(ExportPackageModal, { preview, busy: false, onChange: noop, onConfirm: noop, onCancel: noop }));
  assert.match(html, /value="heat_kernel"/);
  assert.match(html, /<textarea[^>]*>@unpublished\{wang2026heat,/);
  assert.match(html, /saved when you export/);
  assert.match(html, /value="Theorem 1\.2"/);
  assert.match(html, /GOAL/);
  assert.match(html, /NOT APPROVED/);
  assert.match(html, /1\.0\.0 → 1\.1\.0: results added/);
  assert.match(html, /draft_lemma: not approved/);
  assert.match(html, /Included \(2\)/);
  assert.match(html, /disabled=""[^>]*>Export 1\.1\.0…</);
  assert.match(renderToStaticMarkup(React.createElement(ExportPackageModal, { busy: true, onChange: noop, onConfirm: noop, onCancel: noop })), /Reading the project…/);
});

// ---------- git sources ----------

const { execFileSync } = require('node:child_process');
const { parseGitSpec, sourceSpec, loadPackage } = load('../src/services/PackageSources.ts');

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

test('git specs name a URL and an optional ref, and recorded sources fetch again', () => {
  assert.deepEqual(parseGitSpec('https://github.com/a/b.git#v1.2.0'), { url: 'https://github.com/a/b.git', ref: 'v1.2.0' });
  assert.deepEqual(parseGitSpec('git@github.com:a/b.git'), { url: 'git@github.com:a/b.git' });
  assert.deepEqual(parseGitSpec('file:///tmp/x.git#main'), { url: 'file:///tmp/x.git', ref: 'main' });
  assert.equal(parseGitSpec('../paperA'), undefined);
  assert.equal(parseGitSpec('heat.rpkg.json'), undefined);
  assert.equal(sourceSpec({ type: 'git', url: 'https://x/y.git', ref: 'main' }), 'https://x/y.git#main');
  assert.equal(sourceSpec({ type: 'git', url: 'https://x/y.git', ref: 'main' }, 'v2.0.0'), 'https://x/y.git#v2.0.0');
  assert.equal(sourceSpec({ type: 'project', path: '../a' }), '../a');
  assert.throws(() => sourceSpec({ type: 'file', path: 'a.rpkg.json' }, 'main'), /only to packages imported from git/);
});

test('a package imports from git at a tag or branch, with the version its commit records', async () => {
  const { up, down, base } = projects();
  try {
    // Upstream exports 1.0.0, commits the release record, and tags it.
    git(up, 'init', '-q', '-b', 'main');
    const A = await actionsFor(up);
    await A.actions.export({ name: 'heat_kernel' });
    git(up, 'add', '-A');
    git(up, 'commit', '-qm', 'release 1.0.0');
    git(up, 'tag', 'research-v1.0.0');
    const remote = path.join(base, 'upstream.git');
    git(base, 'clone', '-q', '--bare', up, remote);
    const url = `file://${remote}`;

    const B = await actionsFor(down);
    let preview = await B.actions.previewImport(`${url}#research-v1.0.0`, 'hk');
    assert.equal(preview.ok, true, preview.conflicts.join('\n'));
    assert.equal(preview.version, '1.0.0');
    await B.actions.import(`${url}#research-v1.0.0`, 'hk');
    const lock = JSON.parse(fs.readFileSync(path.join(down, 'research/library/hk/package.lock.json'), 'utf8'));
    assert.deepEqual(lock.source, { type: 'git', url, ref: 'research-v1.0.0' });
    assert.equal(lock.resolved, git(up, 'rev-parse', 'HEAD'));
    assert.ok(fs.existsSync(path.join(down, 'research-local/package-cache')));
    // The scratch checkout is gone; only the bare cache stays.
    assert.deepEqual(fs.readdirSync(path.join(down, 'research-local/package-cache')).filter((name) => name.startsWith('tree-')), []);

    // Upstream changes a proof on main without a new release: main builds as a prerelease.
    const theorem = path.join(up, 'research/assets/main_theorem.md');
    fs.writeFileSync(theorem, fs.readFileSync(theorem, 'utf8').replace('Done.', 'Done, directly.'));
    const parsed = matter(fs.readFileSync(theorem, 'utf8'));
    approvedNode(up, 'asset', 'research/assets/main_theorem.md', parsed.data, `${parsed.content.trim()}\n`);
    git(up, 'commit', '-qam', 'sharpen proof');
    git(up, 'push', '-q', remote, 'main');
    // The recorded source still names the tag: nothing new there.
    assert.equal(await B.actions.updateSource('hk'), `${url}#research-v1.0.0`);
    assert.equal((await B.actions.previewImport(await B.actions.updateSource('hk'), undefined, 'hk')).diff.bump, 'none');
    preview = await B.actions.previewImport(`${url}#main`, undefined, 'hk');
    assert.deepEqual([preview.version, preview.diff.bump, preview.diff.proof], ['1.0.1-dev', 'patch', ['lib_hk_main_theorem']]);
    // The default branch, with no ref.
    assert.equal((await loadPackage(url, down)).pkg.version, '1.0.1-dev');

    await assert.rejects(loadPackage(`${url}#no-such-branch`, down), /has no branch, tag, or commit no-such-branch/);
    const empty = path.join(base, 'empty.git');
    git(base, 'init', '-q', '--bare', empty);
    const scratch = path.join(base, 'scratch');
    git(base, 'init', '-q', '-b', 'main', scratch);
    fs.writeFileSync(path.join(scratch, 'README.md'), 'x');
    git(scratch, 'add', '-A');
    git(scratch, 'commit', '-qm', 'x');
    git(scratch, 'push', '-q', empty, 'main');
    await assert.rejects(loadPackage(`file://${empty}#main`, down), /is not a Research Assistant project/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------- this project's citation ----------

const { CitationSection } = load('../webview-src/components/SettingsView.tsx', ['react']);

test('the citation is read, checked, and saved apart from the bibliography', async () => {
  const { up, base } = projects();
  try {
    fs.rmSync(path.join(up, 'research/package/citation.bib'));
    const A = await actionsFor(up);
    let view = await A.actions.citationView('heat_kernel');
    assert.equal(view.saved, false);
    assert.equal(view.path, 'research/package/citation.bib');
    assert.match(view.text, /@unpublished\{heat_kernel,/);
    // With nothing saved, the export dialog starts from the template and is blocked until it is filled in.
    const preview = await A.actions.previewExport({ name: 'heat_kernel' });
    assert.equal(preview.citationSaved, false);
    assert.match(preview.citation, /@unpublished\{heat_kernel,/);
    assert.match(preview.blockers.join('\n'), /No citation for this project yet/);

    view = await A.actions.saveCitation('@misc{Heat,\n title = {x}\n}');
    assert.match(view.problems.join('\n'), /Heat must be lowercase snake_case/);
    assert.equal(fs.existsSync(path.join(up, 'research/package/citation.bib')), false);

    view = await A.actions.saveCitation('@article{wang2026heat,\n  title = {Heat kernel bounds},\n  author = {Wang},\n  year = {2026},\n  doi = {10.1/x}\n}');
    assert.deepEqual([view.saved, view.key, view.problems, view.warnings], [true, 'wang2026heat', [], []]);
    assert.match(fs.readFileSync(path.join(up, 'research/package/citation.bib'), 'utf8'), /doi = \{10\.1\/x\}/);
    // The manuscript's bibliography is untouched.
    assert.equal(fs.readFileSync(path.join(up, 'references.bib'), 'utf8'), '% refs\n');
    assert.equal((await A.actions.previewExport({ name: 'heat_kernel' })).ok, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the Settings citation section shows the entry, its problems, and a save for an unsaved template', () => {
  const template = { path: 'research/package/citation.bib', text: '@unpublished{heat_kernel,\n  title  = {},\n}\n', saved: false, problems: [], warnings: [] };
  const html = renderToStaticMarkup(React.createElement(CitationSection, { view: template, saving: false, onSave: noop }));
  assert.match(html, /This project(&#x27;|')s citation/);
  assert.match(html, /research\/package\/citation\.bib/);
  assert.match(html, /shared with collaborators/);
  assert.match(html, /Nothing is saved yet/);
  assert.match(html, /<textarea[^>]*>@unpublished\{heat_kernel,/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Save</);

  const saved = renderToStaticMarkup(React.createElement(CitationSection, { view: { ...template, saved: true, key: 'heat_kernel', warnings: ['The citation has no url, doi, or eprint: importing projects need a stable link before they share.'] }, saving: false, onSave: noop }));
  assert.match(saved, /no url, doi, or eprint/);
  assert.match(saved, /disabled=""[^>]*>Save</);

  const rejected = renderToStaticMarkup(React.createElement(CitationSection, { view: { ...template, saved: true, problems: ['The citation needs a title.'] }, saving: false, onSave: noop }));
  assert.match(rejected, /The citation needs a title\./);
});

test('removing a package frees its alias, even where empty folders were left behind', async () => {
  const { up, down, base } = projects();
  try {
    const A = await actionsFor(up);
    const exported = await A.actions.export({ name: 'collapsing_lcf' });
    const file = path.join(base, exported.fileName);
    fs.writeFileSync(file, exported.text);
    const B = await actionsFor(down);
    await B.actions.import(file);
    await B.actions.remove('collapsing_lcf');
    // The emptied folders are gone, so the same alias imports again.
    assert.equal(fs.existsSync(path.join(down, 'research/library/collapsing_lcf')), false);
    assert.equal((await B.actions.previewImport(file)).ok, true);

    // Empty folders left by an older removal (or another tool) do not hold the alias either.
    fs.mkdirSync(path.join(down, 'research/library/collapsing_lcf/assets'), { recursive: true });
    fs.mkdirSync(path.join(down, 'research/library/collapsing_lcf/definitions'), { recursive: true });
    const preview = await B.actions.previewImport(file);
    assert.deepEqual(preview.conflicts, []);
    await B.actions.import(file);
    assert.equal((await B.actions.overview()).installed[0].alias, 'collapsing_lcf');

    // A folder that still holds a file is a collection: the alias stays taken, and removal keeps that file.
    await B.actions.remove('collapsing_lcf');
    fs.mkdirSync(path.join(down, 'research/library/collapsing_lcf/assets'), { recursive: true });
    fs.writeFileSync(path.join(down, 'research/library/collapsing_lcf/assets/lib_collapsing_lcf_mine.md'), '---\ntype: lemma\ntitle: Mine\nstatus: draft\n---\n\n## Statement\n\nX.\n');
    assert.match((await B.actions.previewImport(file)).conflicts.join('\n'), /already has a collection named collapsing_lcf/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a git import of a project that was never exported, or exported but not shared, says what to do there', async () => {
  const { up, down, base } = projects();
  try {
    fs.rmSync(path.join(up, 'research/package'), { recursive: true, force: true });
    git(up, 'init', '-q', '-b', 'master');
    git(up, 'add', '-A');
    git(up, 'commit', '-qm', 'paper');
    const remote = path.join(base, 'overleaf.git');
    git(base, 'clone', '-q', '--bare', up, remote);
    const url = `file://${remote}`;
    const notYet = /is a Research Assistant project, but not a package yet: research\/package\/manifest\.json is not in that commit\.\nIn that project, export it once/;
    await assert.rejects(loadPackage(url, down), notYet);

    // Exported in that project but not shared: the remote commit still has no package.
    write(up, 'research/package/citation.bib', '@unpublished{wang2026heat,\n  title = {Heat kernel bounds},\n  author = {Wang},\n  year = {2026}\n}\n');
    const A = await actionsFor(up);
    await A.actions.export({ name: 'heat_kernel' });
    await assert.rejects(loadPackage(url, down), notYet);

    // Shared: it imports, at the version the export recorded.
    git(up, 'add', '-A');
    git(up, 'commit', '-qm', 'export');
    git(up, 'push', '-q', remote, 'master');
    assert.equal((await loadPackage(`${url}#master`, down)).pkg.version, '1.0.0');

    // A project folder that cannot export names the fix in that project.
    fs.rmSync(path.join(up, 'research/package/manifest.json'));
    await assert.rejects(loadPackage(up, down), /The project at .* is not ready to be imported:\n- No package name yet.*\nFix this in that project \(open it, then Library → Export this project…\), and import again\./s);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
