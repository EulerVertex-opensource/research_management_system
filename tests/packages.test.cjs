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

const packages = load('../src/domain/packages.ts');
const bibtex = load('../src/domain/bibtex.ts');
const { PackageService } = load('../src/services/PackageService.ts');
const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { preToolUseDecision } = load('../src/services/ResearchLoopHooks.ts');
const { approvalRecordPath } = load('../src/services/ApprovalStore.ts');
const { approvalDigest } = load('../src/services/ResearchLoopModel.ts');
const { layoutProblem } = load('../src/domain/layout.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
    listDirs: async (folder) => [...new Set([...map.keys()].filter((file) => file.startsWith(`${folder}/`)).map((file) => `${folder}/${file.slice(folder.length + 1).split('/')[0]}`).filter((dir) => [...map.keys()].some((file) => file.startsWith(`${dir}/`))))].sort(),
    deleteFile: async (file) => { map.delete(file); },
  };
}

const node = (data, body) => matter.stringify(`\n${body}`, { status: 'draft', tags: [], ...data });
const project = (required) => `---\ntype: project\nschema_version: 2\nrequired_results:\n${required.map((id) => `  - id: ${id}`).join('\n')}\n---\n\n# Project\n\n## Main Problem\n\nBounds.\n\n## Scope and Assumptions\n\nManifolds.\n\n## Intended Contribution\n\nA bound.\n\n## Background\n\nNone.\n`;

const LI_YAU = '@article{li1986,\n  title = {On the parabolic kernel of the {S}chr\\"odinger operator},\n  author = {Li, Peter and Yau, Shing-Tung},\n  year = {1986},\n  doi = {10.1007/BF02399203}\n}';
const WANG = '@unpublished{wang2026heat,\n  title = {Heat kernel bounds on graphs},\n  author = {Wang, Xiaokang},\n  year = {2026}\n}';

/** Mark a node approved the way the extension does: status plus a matching approval record. */
function approve(map, kind, id) {
  const file = kind === 'asset' ? (map.has(`research/assets/${id}.md`) ? `research/assets/${id}.md` : [...map.keys()].find((key) => key.endsWith(`/assets/${id}.md`))) : (map.has(`research/definitions/${id}.md`) ? `research/definitions/${id}.md` : [...map.keys()].find((key) => key.endsWith(`/definitions/${id}.md`)));
  const parsed = matter(map.get(file));
  const raw = matter.stringify(parsed.content, { ...parsed.data, status: 'approved' });
  map.set(file, raw);
  map.set(approvalRecordPath('research', kind, id), JSON.stringify({ kind, target: id, digest: approvalDigest(raw, kind), approvedAt: '2026-11-01T00:00:00Z', performed_by: 'alice@example.edu', base_commit: 'abc123' }));
}

function upstream() {
  const files = memoryFiles({
    'research/project.md': project(['main_theorem']),
    'research/papers.md': '# Papers\n\n## li1986\n\nLi and Yau, Acta Math.\n- URL: https://doi.org/10.1007/BF02399203\n\n## wang2026heat\n\nThis project.\n- URL: https://arxiv.org/abs/2611.00001\n',
    'references.bib': `${LI_YAU}\n\n${WANG}\n`,
    'research/definitions/heat_kernel_def.md': node({ type: 'definition', title: 'Definition (heat kernel)', source: { kind: 'original' }, depends_on: [] }, '## Statement\n\nThe heat kernel $p_t(x,y)$ is the fundamental solution.\n'),
    'research/library/known/assets/lib_li_yau.md': node({ type: 'lemma', title: 'Li-Yau inequality', source: { kind: 'paper', paper_id: 'li1986', location: 'Theorem 1.1' }, depends_on: [], uses_definitions: [] }, '## Statement\n\nPositive solutions satisfy the Li-Yau gradient bound.\n'),
    'research/assets/gaussian_bound.md': node({ type: 'lemma', title: 'Gaussian upper bound', source: { kind: 'original' }, depends_on: ['lib_li_yau'], uses_definitions: ['heat_kernel_def'], derived_from: 'lib_li_yau' },
      '## Statement\n\nThe [heat kernel](../definitions/heat_kernel_def.md) satisfies a Gaussian bound.\n\n## Proof\n\nIntegrate the Li-Yau inequality.\n\n<!-- research-assistant:backlinks:start -->\nUsed in main_theorem.\n<!-- research-assistant:backlinks:end -->\n'),
    'research/assets/main_theorem.md': node({ type: 'theorem', title: 'Main theorem', source: { kind: 'original' }, depends_on: ['gaussian_bound'], uses_definitions: ['heat_kernel_def'] }, '## Statement\n\nThe heat kernel decays like $t^{-d/2}$.\n\n## Proof\n\nBy the Gaussian bound.\n'),
    'research/assets/side_lemma.md': node({ type: 'lemma', title: 'Unrelated draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [] }, '## Statement\n\nSomething else.\n'),
    'research/ideas/idea_one.md': node({ type: 'idea', title: 'An idea' }, 'Try harder.\n'),
  });
  for (const [kind, id] of [['definition', 'heat_kernel_def'], ['asset', 'lib_li_yau'], ['asset', 'gaussian_bound'], ['asset', 'main_theorem']]) approve(files.map, kind, id);
  return { files, service: new PackageService(files, paths) };
}

const provenance = { commit: 'deadbeef', remote: 'https://github.com/x/heat', exportedAt: '2026-11-07T00:00:00Z' };
const MANIFEST = { name: 'heat_kernel', cite: 'wang2026heat' };

function downstream(extra = {}) {
  const files = memoryFiles({
    'research/project.md': project(['my_result']),
    'research/papers.md': '# Papers\n\n## li_yau_1986\n\nLi-Yau.\n- URL: https://doi.org/10.1007/bf02399203\n\n## wang2026heat\n\nA different paper.\n- URL: https://example.org/w\n',
    'references.bib': `${LI_YAU.replace('li1986', 'li_yau_1986')}\n\n@article{wang2026heat,\n  title = {Waves on trees},\n  author = {Wang, Someone},\n  year = {2026}\n}\n`,
    'main.tex': '\\documentclass{article}\\begin{document}\\cite{li_yau_1986}\\end{document}',
    ...extra,
  });
  return { files, service: new PackageService(files, paths) };
}

async function exported(options = {}) {
  const up = upstream();
  const plan = await up.service.export(provenance, { manifest: MANIFEST, ...options });
  return { up, plan, pkg: plan.package };
}

// ---------- BibTeX helpers ----------

test('BibTeX entries are found by key and compared by the work they name', () => {
  const text = `% comment\n${LI_YAU}\n\n@string{acta = {Acta}}\n\n${WANG}\n`;
  assert.deepEqual(bibtex.parseBibEntries(text).map((entry) => entry.key), ['li1986', 'wang2026heat']);
  assert.equal(bibtex.bibField(LI_YAU, 'doi'), '10.1007/BF02399203');
  assert.ok(bibtex.sameWork(LI_YAU, LI_YAU.replace('li1986', 'other').replace('10.1007/BF02399203', 'https://doi.org/10.1007/bf02399203')));
  assert.ok(!bibtex.sameWork(WANG, WANG.replace('Heat kernel bounds on graphs', 'Something else')));
  assert.equal(bibtex.removeBibEntries(text, new Set(['li1986'])).includes('li1986'), false);
  assert.deepEqual([...bibtex.texCitations('\\citet[Thm 2]{a, b}\\nocite{c}\\cite*{d}')], ['a', 'b', 'c', 'd']);
  assert.equal(bibtex.bibUrl(LI_YAU), 'https://doi.org/10.1007/bf02399203');
});

// ---------- export ----------

test('export takes the approved closure of the required results and leaves everything else behind', async () => {
  const { up, plan, pkg } = await exported({ locations: { main_theorem: 'Theorem 1.2' } });
  assert.equal(plan.ok, true);
  assert.equal(pkg.version, '1.0.0');
  assert.equal(plan.bump, 'initial');
  assert.deepEqual(pkg.exports, ['main_theorem']);
  assert.deepEqual(pkg.nodes.map((n) => n.id), ['gaussian_bound', 'heat_kernel_def', 'lib_li_yau', 'main_theorem']);
  assert.deepEqual(Object.keys(pkg.bib), ['li1986']);
  assert.match(pkg.cite.bibtex, /wang2026heat/);
  assert.match(pkg.cite.paper, /arxiv/);
  const gaussian = matter(pkg.nodes.find((n) => n.id === 'gaussian_bound').raw);
  assert.equal(gaussian.data.status, undefined);
  assert.equal(gaussian.data.derived_from, undefined);
  assert.doesNotMatch(gaussian.content, /backlinks|\.md\)/);
  assert.match(gaussian.content, /The heat kernel satisfies/);
  assert.equal(pkg.nodes.find((n) => n.id === 'main_theorem').location, 'Theorem 1.2');
  assert.deepEqual(pkg.nodes.find((n) => n.id === 'main_theorem').approval, { by: 'alice@example.edu', at: '2026-11-01T00:00:00Z', commit: 'abc123' });
  // The manifest and the release are recorded for collaborators.
  assert.deepEqual(JSON.parse(up.files.map.get('research/package/manifest.json')), MANIFEST);
  assert.equal(JSON.parse(up.files.map.get('research/package/releases.json'))[0].version, '1.0.0');
  // The package file round-trips and detects tampering.
  const text = packages.serializePackage(pkg);
  assert.deepEqual(packages.parsePackage(text), pkg);
  assert.throws(() => packages.parsePackage(text.replace('decays like', 'grows like')), /changed after export/);
  assert.throws(() => packages.parsePackage(JSON.stringify({ ...pkg, formatVersion: 99 })), /update the extension/);
});

test('export is blocked by drafts, conjectures, and a missing cite entry', async () => {
  const up = upstream();
  up.files.map.set('research/assets/main_theorem.md', matter.stringify(matter(up.files.map.get('research/assets/main_theorem.md')).content.replace('decays', 'decays fast'), { ...matter(up.files.map.get('research/assets/main_theorem.md')).data }));
  up.files.map.set('research/assets/cj.md', node({ type: 'conjecture', title: 'Hope', depends_on: [], uses_definitions: [] }, '## Statement\n\nX.\n\n## Motivation\n\nY.\n'));
  up.files.map.set('references.bib', LI_YAU);
  const plan = await up.service.previewExport(provenance, { manifest: { ...MANIFEST, exports: ['main_theorem', 'cj', 'nope'] } });
  assert.equal(plan.ok, false);
  const text = plan.blockers.join('\n');
  assert.match(text, /main_theorem: not approved/); // edited after approval
  assert.match(text, /cj: is a conjecture/);
  assert.match(text, /Export nope is not a result/);
  assert.match(text, /BibTeX entry with key wang2026heat/);
  assert.equal(plan.package, undefined);
  assert.match((await up.service.previewExport(provenance, {})).blockers.join('\n'), /No package manifest yet/);
});

test('versions follow semver from statement and proof digests', async () => {
  const { up } = await exported();
  const edit = (id, from, to) => {
    const file = `research/assets/${id}.md`;
    up.files.map.set(file, up.files.map.get(file).replace(from, to));
    approve(up.files.map, 'asset', id);
  };
  let plan = await up.service.previewExport(provenance);
  assert.equal(plan.bump, 'none');
  assert.equal(plan.unchanged, true);
  assert.equal(plan.version, '1.0.0');

  edit('main_theorem', 'By the Gaussian bound.', 'Apply the Gaussian bound with $x=y$.');
  plan = await up.service.export(provenance);
  assert.deepEqual([plan.bump, plan.version, plan.changes.proof], ['patch', '1.0.1', ['main_theorem']]);

  up.files.map.set('research/assets/corollary.md', node({ type: 'proposition', title: 'Corollary', source: { kind: 'original' }, depends_on: ['main_theorem'], uses_definitions: [] }, '## Statement\n\nOn-diagonal decay.\n\n## Proof\n\nSet x=y.\n'));
  approve(up.files.map, 'asset', 'corollary');
  plan = await up.service.export(provenance, { manifest: { exports: ['main_theorem', 'corollary'] } });
  assert.deepEqual([plan.bump, plan.version], ['minor', '1.1.0']);

  edit('gaussian_bound', 'satisfies a Gaussian bound', 'satisfies a sharp Gaussian bound');
  plan = await up.service.previewExport(provenance);
  assert.deepEqual([plan.bump, plan.version, plan.changes.statement], ['major', '2.0.0', ['gaussian_bound']]);
  assert.match((await up.service.previewExport(provenance, { version: '1.2.0' })).blockers.join('\n'), /understates the change/);
  // A build from a working copy is a prerelease and records no release.
  const dev = await up.service.previewExport(provenance, { dev: true });
  assert.equal(dev.version, '2.0.0-dev');
  assert.equal(dev.release, undefined);
});

// ---------- import ----------

test('import vendors the package with local IDs, citations, and a lockfile, and the project validates', async () => {
  const { pkg } = await exported({ locations: { main_theorem: 'Theorem 1.2' } });
  const down = downstream();
  const plan = await down.service.previewImport(pkg, { alias: 'hk', source: { type: 'file', path: 'heat.rpkg.json' }, now: '2026-11-07T00:00:00Z' });
  assert.equal(plan.ok, true, plan.conflicts.join('\n'));
  assert.deepEqual(plan.nodes.map((n) => n.id), ['lib_hk_gaussian_bound', 'lib_hk_heat_kernel_def', 'lib_hk_li_yau', 'lib_hk_main_theorem']);
  assert.deepEqual(plan.bibChanges, [
    { key: 'wang2026heat', as: 'wang2026heat_hk', action: 'renamed' },
    { key: 'li1986', as: 'li_yau_1986', action: 'reused' },
  ]);
  await down.service.applyImport(plan);
  const map = down.files.map;
  const main = matter(map.get('research/library/hk/assets/lib_hk_main_theorem.md'));
  assert.deepEqual(main.data.source, { kind: 'paper', paper_id: 'wang2026heat_hk', location: 'Theorem 1.2' });
  assert.deepEqual(main.data.depends_on, ['lib_hk_gaussian_bound']);
  assert.deepEqual(main.data.uses_definitions, ['lib_hk_heat_kernel_def']);
  assert.deepEqual(main.data.imported_from, { package: 'heat_kernel', id: 'main_theorem' });
  assert.equal(main.data.status, 'draft');
  assert.deepEqual(matter(map.get('research/library/hk/assets/lib_hk_li_yau.md')).data.source, { kind: 'paper', paper_id: 'li_yau_1986', location: 'Theorem 1.1' });
  assert.equal(matter(map.get('research/library/hk/assets/lib_hk_gaussian_bound.md')).data.source.location, 'result gaussian_bound of heat_kernel');
  assert.match(map.get('references.bib'), /@unpublished\{wang2026heat_hk,/);
  assert.equal(bibtex.parseBibEntries(map.get('references.bib')).length, 3);
  assert.match(map.get('research/papers.md'), /## wang2026heat_hk\n\nThis project\.\n- URL: https:\/\/arxiv/);
  const lock = JSON.parse(map.get('research/library/hk/package.lock.json'));
  assert.equal(lock.version, '1.0.0');
  assert.deepEqual(lock.exports, ['lib_hk_main_theorem']);
  assert.deepEqual(lock.papers, ['wang2026heat_hk']);
  assert.equal(lock.nodes.lib_hk_main_theorem.upstream, 'main_theorem');
  assert.equal(lock.nodes.lib_hk_main_theorem.approval.by, 'alice@example.edu');

  // The importing project is valid: layout, library rules, citations, and the package check.
  map.set('research/assets/my_result.md', node({ type: 'theorem', title: 'My result', source: { kind: 'original' }, depends_on: ['lib_hk_main_theorem'], uses_definitions: [] }, '## Statement\n\nA consequence.\n'));
  const core = new ResearchLoopCore(down.files, paths, { id: () => 'x', iterationCap: 5 });
  assert.deepEqual(await core.validateAll(), []);

  // Approving in the dashboard (status only) keeps the lock valid; editing a statement does not.
  const file = 'research/library/hk/assets/lib_hk_main_theorem.md';
  map.set(file, map.get(file).replace('status: draft', 'status: approved'));
  assert.deepEqual(await down.service.problems(), []);
  map.set(file, map.get(file).replace('decays like', 'decays faster than'));
  map.set('research/library/hk/assets/lib_hk_extra.md', node({ type: 'lemma', title: 'Extra', source: { kind: 'original' }, depends_on: [], uses_definitions: [] }, '## Statement\n\nX.\n'));
  const problems = (await core.validateAll()).join('\n');
  assert.match(problems, /lib_hk_main_theorem\.md: edited after import from heat_kernel 1\.0\.0/);
  assert.match(problems, /lib_hk_extra\.md: not part of package heat_kernel/);
});

test('import plans are deterministic and refuse collisions', async () => {
  const { pkg } = await exported();
  const down = downstream();
  const options = { source: { type: 'file', path: 'x' }, now: '2026-11-07T00:00:00Z' };
  const a = await down.service.previewImport(pkg, options);
  const b = await down.service.previewImport(pkg, options);
  assert.deepEqual(a, b);
  assert.equal(a.alias, 'heat_kernel');

  await down.service.applyImport(await down.service.previewImport(pkg, { ...options, alias: 'hk' }));
  assert.match((await down.service.previewImport(pkg, { ...options, alias: 'hk2' })).conflicts.join('\n'), /already imported as hk; use package update hk/);
  down.files.map.set('research/library/thesis/assets/lib_thesis_a.md', node({ type: 'lemma', title: 'A', source: { kind: 'original' }, depends_on: [], uses_definitions: [] }, '## Statement\n\nA.\n'));
  const other = { ...pkg, name: 'other_pkg' };
  assert.match((await down.service.previewImport(other, { ...options, alias: 'thesis' })).conflicts.join('\n'), /already has a collection named thesis/);
  assert.match((await down.service.previewImport(other, { ...options, alias: 'Bad-Alias' })).conflicts.join('\n'), /Alias Bad-Alias/);
  down.files.map.set('research/package/manifest.json', JSON.stringify({ name: 'other_pkg', cite: 'x' }));
  assert.match((await down.service.previewImport(other, { ...options, alias: 'op' })).conflicts.join('\n'), /cannot import itself/);
});

test('update reports semver changes, keeps the bibliography tidy, and refuses to drop results still in use', async () => {
  const { up, pkg } = await exported();
  const down = downstream();
  const options = { source: { type: 'file', path: 'x' }, now: '2026-11-07T00:00:00Z' };
  await down.service.applyImport(await down.service.previewImport(pkg, { ...options, alias: 'hk' }));

  // Proof-only change upstream: a patch.
  up.files.map.set('research/assets/main_theorem.md', up.files.map.get('research/assets/main_theorem.md').replace('By the Gaussian bound.', 'Directly from the Gaussian bound.'));
  approve(up.files.map, 'asset', 'main_theorem');
  const patch = (await up.service.export(provenance)).package;
  let plan = await down.service.previewUpdate('hk', patch, options);
  assert.equal(plan.ok, true, plan.conflicts.join('\n'));
  assert.deepEqual([plan.diff.from, plan.diff.to, plan.diff.bump, plan.diff.proof], ['1.0.0', '1.0.1', 'patch', ['lib_hk_main_theorem']]);
  assert.equal(plan.bib, undefined); // the bibliography already matches
  await down.service.applyImport(plan);
  assert.equal(bibtex.parseBibEntries(down.files.map.get('references.bib')).length, 3);
  assert.equal((down.files.map.get('research/papers.md').match(/## wang2026heat_hk/g) ?? []).length, 1);

  // Upstream stops exporting through gaussian_bound: removed nodes in use here block the update.
  down.files.map.set('research/assets/mine.md', node({ type: 'lemma', title: 'Mine', source: { kind: 'original' }, depends_on: ['lib_hk_li_yau'], uses_definitions: [] }, '## Statement\n\nM.\n'));
  const smaller = (await up.service.export(provenance, { manifest: { exports: ['heat_kernel_def'] } })).package;
  plan = await down.service.previewUpdate('hk', smaller, options);
  assert.equal(plan.diff.bump, 'major');
  assert.match(plan.conflicts.join('\n'), /lib_hk_li_yau is gone from heat_kernel 2\.0\.0 but mine still uses it/);
  down.files.map.delete('research/assets/mine.md');
  plan = await down.service.previewUpdate('hk', smaller, options);
  assert.equal(plan.ok, true, plan.conflicts.join('\n'));
  await down.service.applyImport(plan);
  assert.equal(down.files.map.has('research/library/hk/assets/lib_hk_main_theorem.md'), false);
  assert.ok(down.files.map.has('research/library/hk/definitions/lib_hk_heat_kernel_def.md'));
  // li_yau_1986 was the project's own entry, so it stays; the package's own cite entry remains while the package does.
  assert.match(down.files.map.get('references.bib'), /li_yau_1986/);
  assert.deepEqual(await down.service.problems(), []);
});

test('remove deletes the package and only the citations nothing else uses', async () => {
  const { pkg } = await exported();
  const down = downstream();
  const before = { bib: down.files.map.get('references.bib'), papers: down.files.map.get('research/papers.md') };
  await down.service.applyImport(await down.service.previewImport(pkg, { alias: 'hk', source: { type: 'file', path: 'x' }, now: 'now' }));

  down.files.map.set('research/assets/mine.md', node({ type: 'lemma', title: 'Mine', source: { kind: 'original' }, depends_on: ['lib_hk_main_theorem'], uses_definitions: [] }, '## Statement\n\nM.\n'));
  let plan = await down.service.previewRemove('hk');
  assert.equal(plan.ok, false);
  assert.match(plan.conflicts.join('\n'), /lib_hk_main_theorem is still used by mine/);
  assert.equal((await down.service.previewRemove('hk', { force: true })).ok, true);
  down.files.map.delete('research/assets/mine.md');

  plan = await down.service.previewRemove('hk');
  assert.deepEqual(plan.removedBibKeys, ['wang2026heat_hk']);
  await down.service.applyRemove(plan);
  assert.equal([...down.files.map.keys()].some((file) => file.startsWith('research/library/hk/')), false);
  assert.equal(down.files.map.get('references.bib').trim(), before.bib.trim());
  assert.equal(down.files.map.get('research/papers.md').trim(), before.papers.trim());

  // A key the manuscript cites is kept.
  await down.service.applyImport(await down.service.previewImport(pkg, { alias: 'hk', source: { type: 'file', path: 'x' }, now: 'now' }));
  down.files.map.set('main.tex', '\\cite{wang2026heat_hk}');
  plan = await down.service.previewRemove('hk');
  assert.deepEqual(plan.removedBibKeys, []);
  assert.match(plan.warnings.join('\n'), /Keeping BibTeX entries cited elsewhere: wang2026heat_hk/);
});

test('promoting an imported result makes a project draft without imported_from', async () => {
  const { pkg } = await exported();
  const down = downstream();
  await down.service.applyImport(await down.service.previewImport(pkg, { alias: 'hk', source: { type: 'file', path: 'x' }, now: 'now' }));
  const core = new ResearchLoopCore(down.files, paths, { id: () => 'x', iterationCap: 5 });
  const file = await core.promote('lib_hk_main_theorem', 'stronger_main');
  const data = matter(down.files.map.get(file)).data;
  assert.equal(data.imported_from, undefined);
  assert.equal(data.derived_from, 'lib_hk_main_theorem');
  assert.deepEqual(await down.service.problems(), []);
});

// ---------- layout and hook ----------

test('the layout allows lockfiles and the package folder, and the hook keeps both read-only', () => {
  assert.equal(layoutProblem(paths, 'research/library/hk/package.lock.json'), undefined);
  assert.equal(layoutProblem(paths, 'research/package/manifest.json'), undefined);
  assert.equal(layoutProblem(paths, 'research/package/releases.json'), undefined);
  assert.ok(layoutProblem(paths, 'research/package/notes.md'));
  assert.ok(layoutProblem(paths, 'research/library/hk/other.json'));

  const exists = (relative) => relative === 'research/library/hk/package.lock.json';
  const deny = (input) => preToolUseDecision(paths, input, '/repo', exists);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: '/repo/research/library/hk/assets/lib_hk_x.md', content: 'x' } }).deny, true);
  assert.match(deny({ tool_name: 'Edit', tool_input: { file_path: 'research/library/hk/assets/lib_hk_x.md', old_string: 'a', new_string: 'b' } }).reason, /read-only.*library promote/);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/library/hk/package.lock.json', content: '{}' } }).deny, true);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/package/releases.json', content: '[]' } }).deny, true);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: "sed -i '' 's/a/b/' research/library/hk/assets/lib_hk_x.md" } }).deny, true);
  // A hand-made collection stays editable, and reading an imported one is fine.
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/library/thesis/assets/lib_t.md', content: '---\nstatus: draft\n---\nx' } }).deny, false);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'cat research/library/hk/assets/lib_hk_x.md' } }).deny, false);
});

test('citation locations are saved in the manifest, so a later folder build cites the same place', async () => {
  const up = upstream();
  await up.service.export(provenance, { manifest: { ...MANIFEST, locations: { main_theorem: 'Theorem 1.2' } } });
  await up.service.export(provenance, { manifest: { locations: { gaussian_bound: 'Lemma 3.1' } } });
  assert.deepEqual(JSON.parse(up.files.map.get('research/package/manifest.json')).locations, { main_theorem: 'Theorem 1.2', gaussian_bound: 'Lemma 3.1' });
  const released = (await up.service.previewExport(provenance)).package;
  const down = downstream();
  await down.service.applyImport(await down.service.previewImport(released, { alias: 'hk', source: { type: 'project', path: '../a' }, now: 'now' }));
  // Building again from the working copy (what a folder import does) changes nothing.
  const dev = await up.service.previewExport(provenance, { dev: true });
  assert.equal(dev.version, released.version);
  const plan = await down.service.previewUpdate('hk', dev.package, { source: { type: 'project', path: '../a' }, now: 'now' });
  assert.equal(plan.diff.bump, 'none');
  assert.equal(matter(plan.writes.find((w) => w.file.endsWith('lib_hk_main_theorem.md')).content).data.source.location, 'Theorem 1.2');
});
