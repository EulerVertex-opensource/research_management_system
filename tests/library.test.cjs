const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const { searchNothing } = require('./search-fixtures.cjs');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { locateNodeFile, libraryProblems, findNodeFile } = load('../src/domain/registry.ts');
const { preToolUseDecision } = load('../src/services/ResearchLoopHooks.ts');
const { planContext, renderContext } = load('../src/services/ResearchContext.ts');
const { buildGraphPayload } = load('../src/services/GraphViewModel.ts');
const { planResearchInterlinks } = load('../src/services/ResearchInterlinks.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const node = (type, title, extra = {}, body = '## Statement\n\nEvery n satisfies P(n).\n') => matter.stringify(`\n${body}`, { type, title, status: 'draft', source: { kind: 'original' }, depends_on: [], ...(type === 'definition' ? {} : { uses_definitions: [] }), tags: [], ...extra });
const LIB = 'research/library/thesis/assets';

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

let counter = 0;
function fixture(initial = {}) {
  const files = memoryFiles({ 'research/project.md': '# Project\n', 'research/papers.md': '# Papers\n', '.research-assistant-loop/settings.json': JSON.stringify({ version: 1, routeWidth: 0 }), ...initial });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map };
}

test('the registry locates project and library nodes and enforces the library rules', async () => {
  assert.deepEqual(locateNodeFile('research/assets/a.md', paths), { kind: 'asset', origin: 'project' });
  assert.deepEqual(locateNodeFile('research/library/thesis/definitions/lib_d.md', paths), { kind: 'definition', origin: 'library', collection: 'thesis' });
  assert.equal(locateNodeFile('research/library/thesis/collection.md', paths), undefined);
  assert.equal(locateNodeFile('research/library/thesis/notes/x.md', paths), undefined);

  const files = memoryFiles({ [`${LIB}/lib_a.md`]: 'x', 'research/library/other/definitions/lib_d.md': 'x', 'research/assets/main.md': 'x' });
  assert.equal(await findNodeFile(files, paths, 'asset', 'lib_a'), `${LIB}/lib_a.md`);
  assert.equal(await findNodeFile(files, paths, 'definition', 'lib_d'), 'research/library/other/definitions/lib_d.md');
  assert.equal(await findNodeFile(files, paths, 'asset', 'main'), 'research/assets/main.md');
  assert.equal(await findNodeFile(files, paths, 'asset', 'missing'), undefined);

  const problems = libraryProblems([
    { id: 'plain', file: `${LIB}/plain.md`, data: {} },
    { id: 'lib_x', file: 'research/assets/lib_x.md', data: {} },
    { id: 'lib_y', file: `${LIB}/lib_y.md`, data: { depends_on: ['main'] } },
    { id: 'lib_z', file: `${LIB}/lib_z.md`, data: { depends_on: ['lib_y'] } },
    { id: 'main', file: 'research/assets/main.md', data: { depends_on: ['lib_z'] } },
  ], paths);
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /plain\.md: library node IDs must start with lib_/);
  assert.match(problems.join('\n'), /lib_x\.md: the lib_ prefix is reserved/);
  assert.match(problems.join('\n'), /lib_y\.md: library node depends on project node main/);
});

test('the loop approves library results once and never falsifies or proves them', async () => {
  const f = fixture({ [`${LIB}/lib_known.md`]: node('lemma', 'Known lemma') });
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.kind === 'project').id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', node('theorem', 'Main theorem', { depends_on: ['lib_known'] }));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });

  // The library lemma is settled by an approval request; the loop moves on to the project result.
  assert.equal((await f.core.next()).stage, 'search');
  assert.equal(f.core.current.current.assetId, 'main_theorem');
  const request = f.core.current.approvalQueue.find((item) => item.target === 'lib_known');
  assert.equal(request.kind, 'asset');
  assert.match(request.reason, /Library result \(thesis\)/);

  await f.core.resolveApproval(request.id, 'approved', '', 'test');
  assert.equal(matter(f.map.get(`${LIB}/lib_known.md`)).data.status, 'approved');
  assert.ok(f.map.has('research/approvals/assets/lib_known.json'));
  assert.deepEqual(await f.core.validateAll(), []);

  // A collaborator's edit to an approved library result reverts it to draft.
  f.map.set(`${LIB}/lib_known.md`, f.map.get(`${LIB}/lib_known.md`).replace('P(n)', 'Q(n)'));
  assert.deepEqual(await f.core.reconcile('lib_known'), ['lib_known']);
  assert.equal(matter(f.map.get(`${LIB}/lib_known.md`)).data.status, 'draft');
});

test('library files can be added and edited during a stage, and still follow the library rules', async () => {
  const f = fixture({ [`${LIB}/lib_known.md`]: node('lemma', 'Known lemma') });
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.kind === 'project').id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', node('theorem', 'Main theorem', { depends_on: ['lib_known', 'lib_new'] }));
  f.map.set(`${LIB}/lib_new.md`, node('lemma', 'New known lemma'));
  f.map.set(`${LIB}/lib_known.md`, node('lemma', 'Known lemma, edited'));
  f.map.set(`${LIB}/plain_name.md`, node('lemma', 'Unprefixed'));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Scaffolded' }), /plain_name\.md: library node IDs must start with lib_/);
  f.map.delete(`${LIB}/plain_name.md`);
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  assert.equal(f.core.current.stage, 'sources');
  // A later stage may also touch the library, e.g. adding links or fixing a typo.
  f.map.set(`${LIB}/lib_known.md`, node('lemma', 'Known lemma, typo fixed'));
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'search');
  f.map.set(`${LIB}/lib_new.md`, node('lemma', 'New known lemma, linked'));
  await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');

  f.map.set(`${LIB}/lib_bad.md`, node('lemma', 'Depends on project', { depends_on: ['main_theorem'] }));
  assert.match((await f.core.validateAll()).join('\n'), /lib_bad\.md: library node depends on project node main_theorem/);
});

test('the hook lets the agent add and edit library files but never approve them', () => {
  const deny = (input) => preToolUseDecision(paths, input, '/repo').deny;
  const draft = '---\nstatus: draft\n---\nfine';
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/library/thesis/assets/lib_new.md', content: draft } }), false);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: '/repo/research/library/thesis/assets/lib_old.md', content: draft } }), false);
  assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: 'research/library/thesis/assets/lib_old.md', old_string: 'a', new_string: 'b' } }), false);
  assert.equal(deny({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: research/library/thesis/assets/lib_old.md\n@@\n-a\n+b\n*** End Patch' } }), false);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'node .agents/skills/research-maintenance/scripts/research-maintenance.cjs links --file research/library/thesis/assets/lib_old.md --apply' } }), false);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/library/thesis/assets/lib_new.md', content: '---\nstatus: approved\n---\n' } }), true);
  assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: 'research/library/thesis/assets/lib_old.md', old_string: 'status: draft', new_string: 'status: approved' } }), true);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: "sed -i '' 's/status: draft/status: approved/' research/library/thesis/assets/lib_old.md" } }), true);
});

test('context packs and the graph show only library results the research references', () => {
  const asContext = (id, raw, file, library) => { const parsed = matter(raw); return { id, file, raw, data: parsed.data, body: parsed.content, ...(library ? { origin: 'library', collection: 'thesis' } : {}) }; };
  const main = node('theorem', 'Main theorem', { depends_on: ['lib_used'] });
  const used = node('lemma', 'Used lemma');
  const unused = node('lemma', 'Unused lemma');
  const sources = {
    project, projectFile: paths.projectMd, paperIndex: '', paperIndexFile: paths.paperIndex,
    assets: new Map([
      ['main_theorem', asContext('main_theorem', main, 'research/assets/main_theorem.md')],
      ['lib_used', asContext('lib_used', used, `${LIB}/lib_used.md`, true)],
      ['lib_unused', asContext('lib_unused', unused, `${LIB}/lib_unused.md`, true)],
    ]),
    definitions: new Map(), plans: new Map(), ideas: new Map(), checks: new Map(), reports: [],
  };
  const manifest = planContext({ stage: 'scaffold', missing: [], incomplete: [] }, sources);
  const text = renderContext(manifest, sources, 'research-loop show').text;
  assert.match(text, /lib_used \| lemma .* \| library:thesis/);
  assert.doesNotMatch(text, /lib_unused \|/);
  assert.match(text, /1 more library result\(s\) not referenced yet: research-loop library search/);

  const graphNode = (id, raw, filePath, library) => { const data = matter(raw).data; return { id, filePath, body: '', ...data, ...(library ? { origin: 'library', collection: 'thesis' } : {}) }; };
  const payload = buildGraphPayload({
    nodes: [graphNode('main_theorem', main, 'research/assets/main_theorem.md'), graphNode('lib_used', used, `${LIB}/lib_used.md`, true), graphNode('lib_unused', unused, `${LIB}/lib_unused.md`, true)],
    project, projectApproved: true, sectionsDir: 'sections', now: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(payload.nodes.map((item) => item.id).sort(), ['lib_used', 'main_theorem']);
  assert.equal(payload.nodes.find((item) => item.id === 'lib_used').origin, 'library');
  assert.deepEqual(payload.edges, [{ from: 'main_theorem', to: 'lib_used', type: 'depends_on' }]);
});

test('interlinks reach library results a project node references, and no others', () => {
  const inputs = [
    { filePath: 'research/assets/main_theorem.md', raw: node('theorem', 'Main theorem', { depends_on: ['lib_used'] }, 'By the Used Lemma and the Unused Lemma.') },
    { filePath: `${LIB}/lib_used.md`, raw: node('lemma', 'Used Lemma') },
    { filePath: `${LIB}/lib_unused.md`, raw: node('lemma', 'Unused Lemma') },
  ];
  const plan = planResearchInterlinks(inputs, paths.assets, paths.definitions, paths.library);
  assert.match(plan.changes[0].raw, /\[Used Lemma\]\(\.\.\/library\/thesis\/assets\/lib_used\.md\)/);
  assert.match(plan.changes[0].raw, /the Unused Lemma\./);
  assert.deepEqual(plan.issues, []);
});

test('library search ranks by title, tags, and statement, and promote copies a result into the project', async () => {
  const f = fixture({
    [`${LIB}/lib_compact_embedding.md`]: node('theorem', 'Compact embedding theorem', { tags: ['sobolev'] }, '## Statement\n\nThe embedding is compact; see [widget](../definitions/lib_widget.md).\n\n## Proof\n\nRellich.\n'),
    [`${LIB}/lib_trace.md`]: node('lemma', 'Trace lemma', {}, '## Statement\n\nTraces of Sobolev functions exist.\n'),
    'research/library/thesis/definitions/lib_widget.md': node('definition', 'Definition (widget)', {}, 'A widget.'),
    'research/assets/main_theorem.md': node('theorem', 'Main theorem'),
  });
  const hits = await f.core.librarySearch('sobolev embedding');
  assert.deepEqual(hits.map((hit) => hit.id), ['lib_compact_embedding', 'lib_trace']);
  assert.equal(hits[0].collection, 'thesis');
  assert.equal(hits[0].approved, false);
  assert.deepEqual((await f.core.librarySearch('', { type: 'definition' })).map((hit) => hit.id), ['lib_widget']);
  assert.equal((await f.core.librarySearch('', { unapproved: true })).length, 3);

  const file = await f.core.promote('lib_compact_embedding');
  assert.equal(file, 'research/assets/compact_embedding.md');
  const promoted = matter(f.map.get(file));
  assert.equal(promoted.data.status, 'draft');
  assert.equal(promoted.data.derived_from, 'lib_compact_embedding');
  assert.match(promoted.content, /\[widget\]\(\.\.\/library\/thesis\/definitions\/lib_widget\.md\)/);
  await assert.rejects(f.core.promote('lib_compact_embedding'), /already exists/);
  await assert.rejects(f.core.promote('main_theorem'), /No library result/);
  await assert.rejects(f.core.promote('lib_trace', 'lib_other'), /without the lib_ prefix/);
  assert.deepEqual(await f.core.validateAll(), []);
});

test('library search folds plurals and British spelling and ignores stop words', async () => {
  const f = fixture({
    [`${LIB}/lib_neighbourhoods.md`]: node('theorem', 'Canonical neighbourhoods through surgeries', {}, '## Statement\n\nHigh curvature points have canonical neighbourhoods.\n'),
    [`${LIB}/lib_other.md`]: node('lemma', 'A lemma on the flow and the metric', {}, '## Statement\n\nThe metric is smooth.\n'),
  });
  assert.deepEqual((await f.core.librarySearch('canonical neighborhood surgery')).map((hit) => hit.id), ['lib_neighbourhoods']);
  assert.deepEqual((await f.core.librarySearch('the surgery')).map((hit) => hit.id), ['lib_neighbourhoods'], '"the" no longer matches every title');
});

test('the plan pack lists library analogues; an adapting plan must say what transfers, and execute reads the adapted proof', async () => {
  const f = fixture({
    [`${LIB}/lib_known.md`]: node('lemma', 'Known lemma', {}, '## Statement\n\nGadgets exist.\n'),
    [`${LIB}/lib_analogue.md`]: node('theorem', 'Blue widget theorem for gadgets', {}, '## Statement\n\nEvery gadget widget is blue.\n\n## Proof\n\nANALOGUE PROOF.\n'),
    [`${LIB}/lib_unrelated.md`]: node('lemma', 'Trace lemma', {}, '## Statement\n\nTraces exist.\n'),
  });
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.kind === 'project').id, 'approved', '', 'test');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', node('theorem', 'Blue widget theorem', { depends_on: ['lib_known'], tags: ['colour'] }, '## Statement\n\nEvery widget is blue.\n'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
  assert.equal((await f.core.next()).stage, 'search');
  await searchNothing(f);
  assert.equal(f.core.current.stage, 'plan');

  const planPack = (await f.core.contextPack()).text;
  assert.match(planPack, /### Library analogues \(not in depends_on\)/);
  assert.match(planPack, /- lib_analogue \(thesis, draft\): Blue widget theorem for gadgets — Every gadget widget is blue\./);
  assert.doesNotMatch(planPack, /- lib_known /, 'a dependency is already in the pack, not an analogue');
  assert.doesNotMatch(planPack, /lib_unrelated/);
  assert.doesNotMatch(planPack, /ANALOGUE PROOF/, 'the plan stage reads an analogue proof on request');

  const planFile = (adapted = '') => matter.stringify(`\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\n## Plan\n\n1. [ ] As in lib_analogue, with widgets for gadgets.\n\n## Verification\n\nThe one step is the statement.\n\n## Assumed definitions\n\nNone.\n${adapted}`, { type: 'plan', title: 'Adapt', status: 'pending', target_asset: 'main_theorem', inspired_by: [], adapts: ['lib_analogue'], tags: [] });
  f.map.set('research/plans/attempt_1.md', planFile());
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' }), /## Adapted from must name lib_analogue/);
  f.map.set('research/plans/attempt_1.md', matter.stringify(matter(planFile()).content, { ...matter(planFile()).data, adapts: ['lib_missing'] }));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' }), /adapts unknown result lib_missing/);
  f.map.set('research/plans/attempt_1.md', planFile('\n## Adapted from\n\n- lib_analogue: its hypotheses hold for widgets; no step changes.\n'));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'attempt_1' });
  assert.equal(f.core.current.stage, 'execute');

  const executePack = (await f.core.contextPack()).text;
  assert.match(executePack, /### asset lib_analogue — .*\n[^]*ANALOGUE PROOF/, 'execute reads the full proof it adapts');
  assert.doesNotMatch(executePack, /Library analogues/);
});

test('library results stay out of the Assets list', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../webview-src/components/NodeList.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  const { NodeList } = module.exports;
  const nodes = [
    { id: 'main_theorem', type: 'theorem', title: 'Main theorem', status: 'draft', tags: [], filePath: 'research/assets/main_theorem.md', body: '' },
    { id: 'lib_a', type: 'lemma', title: 'Library lemma A', status: 'draft', tags: [], filePath: `${LIB}/lib_a.md`, body: '', origin: 'library', collection: 'thesis' },
    { id: 'lib_b', type: 'lemma', title: 'Library lemma B', status: 'approved', tags: [], filePath: `${LIB}/lib_b.md`, body: '', origin: 'library', collection: 'thesis' },
  ];
  const render = (filterType) => renderToStaticMarkup(React.createElement(NodeList, { nodes, selectedId: null, onSelect: () => {}, filterType }));
  const assets = render('asset');
  assert.match(assets, /Main theorem/);
  assert.doesNotMatch(assets, /Library lemma/);
  const library = render('library');
  assert.doesNotMatch(library, /Main theorem/);
  assert.match(library, /Library lemma A/);
  assert.match(library, /Library lemma B/);
  // Extracted results are checked one by one, never in bulk.
  assert.doesNotMatch(library, /as checked</);
  assert.match(library, /✓ KNOWN RESULT</, 'a checked known result shows one purple badge');
  assert.match(library, /NOT CHECKED · KNOWN RESULT</, 'an unchecked one shows the grey badge');
  assert.doesNotMatch(library, /<span[^>]*>approved<\/span>/i, 'no separate status badge next to it');
});
