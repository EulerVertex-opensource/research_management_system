const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { researchDigest, assetComponents, projectFacets } = load('../src/domain/digests.ts');
const { parseSectionBrief } = load('../src/services/ManuscriptWriting.ts');
const { appendProjectRevision, projectRevisionHistory, currentProjectRevision, diffProjectRevisions, readProjectRevisions } = load('../src/services/ApprovalStore.ts');
const { buildGraph } = load('../src/domain/graph.ts');
const { NodeLoopFiles } = load('../src/cli/nodeFiles.ts');
const { parseTexBlocks, blockStart } = load('../src/domain/texBlocks.ts');
const cli = path.resolve(__dirname, '../out/manuscript-writing.cjs');

const project = (required = ['main_theorem'], contribution = 'A proof of A.') => `---\ntype: project\nschema_version: 2\nrequired_results:\n${required.map((id) => `  - id: ${id}\n    role: result\n`).join('')}---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\n${contribution}\n\n## Background\n\nNone.\n`;
const node = (type, fields, body) => `---\ntype: ${type}\ntitle: ${fields.title ?? type}\nstatus: ${fields.status ?? 'approved'}\n${type === 'definition' ? '' : `source:\n  kind: original\nuses_definitions: [${(fields.defs ?? []).join(', ')}]\n`}depends_on: [${(fields.deps ?? []).join(', ')}]\n---\n\n${body}\n`;
const theorem = (proof = 'By the lemma.') => node('theorem', { title: 'Main theorem', deps: ['helper'] }, `## Statement\n\nEvery widget is round.\n\n## Proof\n\n${proof}`);
const lemma = (status = 'approved') => node('lemma', { title: 'Helper', defs: ['widget'], status }, '## Statement\n\nWidgets exist.\n\n## Proof\n\nConstruct one.');
const widget = (text = 'A widget is a round gadget.') => node('definition', { title: 'Widget' }, `## Statement\n\n${text}`);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manuscript-impact-'));
  const at = (relative) => path.join(root, relative);
  const write = (relative, content) => { fs.mkdirSync(path.dirname(at(relative)), { recursive: true }); fs.writeFileSync(at(relative), content); };
  const read = (relative) => fs.readFileSync(at(relative), 'utf8');
  write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
  write('main.tex', '\\documentclass{article}\n\\begin{document}\n% research-assistant:sections:start\n% research-assistant:sections:end\n\\end{document}\n');
  write('references.bib', '');
  write('research/project.md', project());
  write('research/approvals/project.json', JSON.stringify({ kind: 'project', target: 'project', digest: researchDigest(project(), 'project'), approvedAt: '2026-01-01T00:00:00Z' }));
  write('research/assets/main_theorem.md', theorem());
  write('research/assets/helper.md', lemma());
  write('research/definitions/widget.md', widget());
  write('research/writing/outline.md', '# Outline\n\n## Sections\n\n1. [Introduction](sections/introduction.md)\n2. [Main result](sections/main_result.md)\n');
  write('research/writing/sections/introduction.md', '---\ntitle: Introduction\nsources:\n  - id: main_theorem\n    role: central_result\n    uses: [statement]\nproject_facets: [contribution]\n---\n\n## Purpose\n\nMotivate.\n');
  write('research/writing/sections/main_result.md', '---\ntitle: Main result\nassets: [main_theorem]\n---\n\n## Purpose\n\nProve it.\n');
  write('sections/introduction.tex', '\\section{Introduction}\n% [main_theorem]\nWe prove that every widget is round.\n');
  write('sections/main_result.tex', '\\section{Main result}\n% [main_theorem]\n\\begin{theorem}Every widget is round.\\end{theorem}\n');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' });
  const impact = () => { const result = run('impact', '--json'); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const section = (report, id) => report.sections.find((item) => item.id === id);
  const lockAll = () => { for (const id of ['introduction', 'main_result']) { const result = run('lock', id, '--apply'); assert.equal(result.status, 0, result.stderr); } };
  return { root, write, read, run, impact, section, lockAll, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('briefs accept plain assets, sources with roles and components, and project facets', () => {
  const plain = parseSectionBrief('---\ntitle: T\nassets: [a, b]\n---\n', 't');
  assert.deepEqual(plain.sources[0], { id: 'a', uses: ['statement', 'proof', 'source'] });
  const rich = parseSectionBrief('---\ntitle: T\nassets: [a]\nsources:\n  - id: b\n    role: motivation\n    uses: [statement]\n  - c\nproject_facets: [contribution, scope]\n---\n', 't');
  assert.deepEqual(rich.assets, ['a', 'b', 'c']);
  assert.deepEqual(rich.sources[1], { id: 'b', role: 'motivation', uses: ['statement'] });
  assert.deepEqual(rich.projectFacets, ['contribution', 'scope']);
  assert.throws(() => parseSectionBrief('---\ntitle: T\nassets: [a]\nsources: [a]\n---\n', 't'), /repeats/);
  assert.throws(() => parseSectionBrief('---\ntitle: T\nsources:\n  - id: a\n    uses: [lemma]\n---\n', 't'), /uses must list/);
  assert.throws(() => parseSectionBrief('---\ntitle: T\nsources: [a]\nproject_facets: [tone]\n---\n', 't'), /project_facets/);
  assert.throws(() => parseSectionBrief('---\ntitle: T\n---\n', 't'), /assets list/);
});

test('component digests separate statement, proof, and citation', () => {
  const base = assetComponents(theorem());
  assert.equal(assetComponents(theorem('Another proof.')).statement, base.statement);
  assert.notEqual(assetComponents(theorem('Another proof.')).proof, base.proof);
  const cited = theorem().replace('kind: original', 'kind: paper\n  paper_id: smith2020');
  assert.equal(assetComponents(cited).statement, base.statement);
  assert.notEqual(assetComponents(cited).source, base.source);
  assert.equal(projectFacets(project(['main_theorem'], 'New.')).problem, projectFacets(project()).problem);
  assert.notEqual(projectFacets(project(['main_theorem'], 'New.')).contribution, projectFacets(project()).contribution);
});

test('project revisions: a legacy approval reads as revision 1 and the next approval is revision 2', async () => {
  const p = fixture();
  try {
    const files = new NodeLoopFiles(p.root);
    const legacy = JSON.parse(p.read('research/approvals/project.json'));
    const history = await projectRevisionHistory(files, 'research', [legacy]);
    assert.equal(currentProjectRevision(history, project()).revision, 1);
    assert.equal((await readProjectRevisions(files, 'research')).length, 0);
    const extended = project(['main_theorem', 'second_theorem']);
    assert.match(await appendProjectRevision(files, 'research', extended, { approvedAt: 'now' }, legacy), /rev-0002\.json$/);
    assert.equal(await appendProjectRevision(files, 'research', extended, { approvedAt: 'later' }), undefined);
    const stored = await readProjectRevisions(files, 'research');
    assert.equal(currentProjectRevision(stored, extended).revision, 2);
    const diff = diffProjectRevisions({ facets: projectFacets(project()), required_results: [{ id: 'main_theorem' }] }, stored[0]);
    assert.deepEqual(diff, { addedRequired: ['second_theorem'], removedRequired: [], changedFacets: ['required'] });
  } finally { p.cleanup(); }
});

test('the graph derives typed edges and reaches dependencies without workflow edges', () => {
  const graph = buildGraph({
    project: project(),
    nodes: [
      { id: 'main_theorem', kind: 'asset', data: { depends_on: ['helper'] } },
      { id: 'helper', kind: 'asset', data: { uses_definitions: ['widget'] } },
      { id: 'widget', kind: 'definition', data: {} },
      { id: 'attempt', kind: 'plan', data: { target_asset: 'main_theorem', inspired_by: ['hunch'] } },
      { id: 'hunch', kind: 'idea', data: { related_assets: ['helper'] } },
    ],
    sections: [{ id: 'main_result', sources: [{ id: 'main_theorem', uses: ['statement'] }] }],
  });
  assert.deepEqual(graph.out('project:project').map((edge) => edge.to), ['asset:main_theorem']);
  assert.deepEqual(graph.reachable(['asset:main_theorem'], ['depends_on', 'uses_definition']), ['asset:helper', 'definition:widget']);
  assert.deepEqual(graph.reachable(['definition:widget'], ['depends_on', 'uses_definition', 'presents'], 'in'), ['asset:helper', 'asset:main_theorem', 'section:main_result']);
  assert.equal(graph.in('asset:helper', ['depends_on', 'uses_definition']).length, 1);
});

test('lock snapshots a section; impact reports only what changed, by component', () => {
  const p = fixture();
  try {
    let report = p.impact();
    assert.equal(report.state, 'unlocked');
    assert.equal(p.section(report, 'main_result').state, 'unlocked');
    const preview = p.run('lock', 'introduction');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Source: helper \(statement\) via main_theorem/);
    assert.equal(fs.existsSync(path.join(p.root, 'research/writing/bindings/introduction.json')), false);
    p.lockAll();
    report = p.impact();
    assert.equal(report.state, 'current');
    assert.equal(report.projectRevision, 1);
    assert.match(p.run('impact').stdout, /Manuscript: current \(project revision 1\)/);

    let prepared = p.run('prepare', 'main_result');
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /Lock: current at project revision 1/);
    assert.doesNotMatch(prepared.stdout, /^Context:/m);
    assert.match(p.run('prepare', 'main_result', '--full').stdout, /Context: research\/assets\/main_theorem\.md/);

    // A proof change: the section that presents the proof is stale; the one that states the theorem is not.
    p.write('research/assets/main_theorem.md', theorem('By the lemma and compactness.'));
    report = p.impact();
    assert.equal(report.state, 'stale');
    assert.equal(p.section(report, 'introduction').state, 'current');
    assert.deepEqual(p.section(report, 'main_result').stale, [{ id: 'main_theorem', via: 'direct', components: ['proof'] }]);
    prepared = p.run('prepare', 'main_result');
    assert.match(prepared.stdout, /Changed: main_theorem \(proof\)/);
    assert.match(prepared.stdout, /Context: research\/assets\/main_theorem\.md/);
    assert.doesNotMatch(prepared.stdout, /Context: research\/definitions\/widget\.md/);
    assert.match(prepared.stdout, /Unchanged since lock .*helper, widget/);

    // A definition change reaches every section whose results use it.
    p.lockAll();
    p.write('research/definitions/widget.md', widget('A widget is a smooth gadget.'));
    report = p.impact();
    assert.deepEqual(p.section(report, 'main_result').stale, [{ id: 'widget', via: 'main_theorem', components: ['statement'] }]);
    assert.equal(p.section(report, 'introduction').state, 'stale');
    assert.match(p.run('impact').stdout, /widget statement changed \(dependency of main_theorem\)/);
  } finally { p.cleanup(); }
});

test('scope changes: contribution edits stale only rhetorical sections; new required results are uncovered; removed ones are orphaned', () => {
  const p = fixture();
  try {
    p.lockAll();
    p.write('research/project.md', project(['main_theorem'], 'A short proof of A.'));
    let report = p.impact();
    assert.deepEqual(p.section(report, 'introduction').facets, ['contribution']);
    assert.equal(p.section(report, 'main_result').state, 'current');
    assert.equal(report.projectRevision, undefined);

    p.write('research/project.md', project(['main_theorem', 'second_theorem']));
    report = p.impact();
    assert.deepEqual(report.uncovered, [{ id: 'second_theorem', pending: true }]);
    assert.equal(p.section(report, 'main_result').state, 'current');
    assert.equal(report.state, 'uncovered');
    assert.match(p.run('impact').stdout, /Uncovered required results: second_theorem \(research in progress\)/);

    p.write('research/project.md', project(['second_theorem']));
    report = p.impact();
    assert.deepEqual(p.section(report, 'main_result').orphaned, ['main_theorem']);
  } finally { p.cleanup(); }
});

test('deprecated or unapproved sources make a binding invalid, and lock refuses them', () => {
  const p = fixture();
  try {
    p.lockAll();
    p.write('research/assets/main_theorem.md', `${theorem().trimEnd()}\n\n% edited\n`);
    p.write('research/approvals/assets/main_theorem.json', JSON.stringify({ kind: 'asset', target: 'main_theorem', digest: 'stale', approvedAt: 'then' }));
    let report = p.impact();
    assert.deepEqual(p.section(report, 'main_result').invalid, [{ id: 'main_theorem', reason: 'unapproved' }]);
    assert.equal(report.state, 'invalid');
    const refused = p.run('lock', 'main_result', '--apply');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /main_theorem is unapproved/);

    fs.rmSync(path.join(p.root, 'research/approvals/assets/main_theorem.json'));
    p.write('research/assets/helper.md', lemma('deprecated'));
    report = p.impact();
    assert.deepEqual(p.section(report, 'main_result').invalid, [{ id: 'helper', reason: 'deprecated' }]);
  } finally { p.cleanup(); }
});

test('brief edits and TeX edits after a lock are reported', () => {
  const p = fixture();
  try {
    p.lockAll();
    p.write('research/writing/sections/main_result.md', '---\ntitle: Main result\nassets: [main_theorem, helper]\n---\n');
    p.write('sections/main_result.tex', `${p.read('sections/main_result.tex')}A researcher's remark.\n`);
    const section = p.section(p.impact(), 'main_result');
    assert.deepEqual(section.added, ['helper']);
    assert.equal(section.texEdited, true);
    assert.equal(section.state, 'stale');
    assert.equal(p.section(p.impact(), 'introduction').texEdited, false);
  } finally { p.cleanup(); }
});

test('block markers parse sources, components, and policy, and report malformed markers', () => {
  const tex = [
    '\\section{Main}',
    '% [main_theorem]',
    '% research-assistant:block id=statement sources=main_theorem@statement policy=managed',
    'Theorem.',
    '% research-assistant:endblock',
    '% research-assistant:block id=proof sources=main_theorem@proof,helper@statement+source',
    'Proof.',
    '% research-assistant:endblock',
  ].join('\n');
  const parsed = parseTexBlocks(tex);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.tags, ['main_theorem']);
  assert.deepEqual(parsed.blocks.map((block) => [block.id, block.policy, block.startLine, block.endLine, block.text]), [['statement', 'managed', 3, 5, 'Theorem.'], ['proof', 'assisted', 6, 8, 'Proof.']]);
  assert.deepEqual(parsed.blocks[1].sources, [{ id: 'main_theorem', components: ['proof'] }, { id: 'helper', components: ['statement', 'source'] }]);
  assert.equal(blockStart('b', [{ id: 'x', components: ['statement', 'proof', 'source'] }]), '% research-assistant:block id=b sources=x policy=assisted');
  const broken = parseTexBlocks('% research-assistant:block id=a sources=x@lemma\n% research-assistant:block id=a policy=loose\n% research-assistant:endblock\n% research-assistant:endblock');
  assert.equal(broken.problems.length, 5);
});

const blockedTex = [
  '\\section{Main result}',
  'Some prose introducing the result.',
  '% research-assistant:block id=main-statement sources=main_theorem@statement',
  '\\begin{theorem}Every widget is round.\\end{theorem}',
  '% research-assistant:endblock',
  '% research-assistant:block id=main-proof sources=main_theorem@proof policy=manual',
  '\\begin{proof}By the lemma.\\end{proof}',
  '% research-assistant:endblock',
  '',
].join('\n');

test('with blocks, impact points at the blocks a change touches and prepare lists their lines and policy', () => {
  const p = fixture();
  try {
    p.write('research/writing/sections/main_result.md', '---\ntitle: Main result\nsources:\n  - id: main_theorem\n    uses: [statement, proof]\n---\n');
    p.write('sections/main_result.tex', blockedTex);
    const locked = p.run('lock', 'main_result', '--apply');
    assert.equal(locked.status, 0, locked.stderr);
    assert.match(locked.stdout, /Block: main-proof \[manual\] main_theorem@proof/);
    const binding = JSON.parse(p.read('research/writing/bindings/main_result.json'));
    assert.deepEqual(binding.blocks.map((block) => block.id), ['main-statement', 'main-proof']);
    assert.deepEqual(Object.keys(binding.sources[0].digests).sort(), ['proof', 'source', 'statement']);

    p.write('research/assets/main_theorem.md', theorem('By the lemma and compactness.'));
    let section = p.section(p.impact(), 'main_result');
    assert.equal(section.state, 'stale');
    assert.deepEqual(section.blocks.map((block) => [block.id, block.state]), [['main-statement', 'current'], ['main-proof', 'stale']]);
    assert.deepEqual(section.blocks[1].lines, [6, 8]);
    assert.deepEqual(section.outside, []);
    assert.match(p.run('impact').stdout, /block main-proof \[manual\] lines 6-8: stale — main_theorem proof changed/);
    const prepared = p.run('prepare', 'main_result');
    assert.match(prepared.stdout, /Block: main-proof sections\/main_result\.tex:6-8 \[manual\] — main_theorem proof\. Do not edit/);
    assert.match(prepared.stdout, /Current blocks \(leave unchanged\): main-statement/);
    assert.match(prepared.stdout, /Read only the listed block lines/);

    // A dependency change reaches the blocks presenting the result that depends on it.
    p.write('research/assets/main_theorem.md', theorem());
    p.write('research/definitions/widget.md', widget('A widget is a smooth gadget.'));
    section = p.section(p.impact(), 'main_result');
    assert.deepEqual(section.blocks.map((block) => block.state), ['stale', 'stale']);
    assert.deepEqual(section.blocks[0].stale, [{ id: 'widget', via: 'main_theorem', components: ['statement'] }]);
    assert.deepEqual(section.outside, []);
  } finally { p.cleanup(); }
});

test('changes no block presents are reported outside the blocks; edited, added, and removed blocks are noted', () => {
  const p = fixture();
  try {
    p.write('sections/main_result.tex', blockedTex.replace('% research-assistant:block id=main-proof sources=main_theorem@proof policy=manual\n\\begin{proof}By the lemma.\\end{proof}\n% research-assistant:endblock\n', ''));
    p.lockAll();
    p.write('research/assets/main_theorem.md', theorem('Another proof.'));
    let section = p.section(p.impact(), 'main_result');
    assert.deepEqual(section.blocks.map((block) => block.state), ['current']);
    assert.deepEqual(section.outside, [{ id: 'main_theorem', via: 'direct', components: ['proof'] }]);
    assert.equal(section.state, 'stale');
    assert.match(p.run('impact').stdout, /outside blocks: main_theorem proof changed/);

    p.write('sections/main_result.tex', blockedTex.replace('Every widget is round.', 'Every widget is very round.'));
    section = p.section(p.impact(), 'main_result');
    assert.equal(section.blocks[0].textEdited, true);
    assert.deepEqual(section.newBlocks, ['main-proof']);
    p.write('sections/main_result.tex', '\\section{Main result}\n');
    assert.deepEqual(p.section(p.impact(), 'main_result').removedBlocks, ['main-statement']);
  } finally { p.cleanup(); }
});

test('lock refuses malformed markers and blocks citing nodes outside the brief', () => {
  const p = fixture();
  try {
    p.write('sections/main_result.tex', '% research-assistant:block id=x sources=main_theorem\nText.\n');
    assert.match(p.run('lock', 'main_result', '--apply').stderr, /block x has no endblock/);
    p.write('sections/introduction.tex', '% research-assistant:block id=x sources=unrelated\nText.\n% research-assistant:endblock\n');
    assert.match(p.run('lock', 'introduction', '--apply').stderr, /x cites unrelated, which the brief neither lists nor depends on/);
  } finally { p.cleanup(); }
});
