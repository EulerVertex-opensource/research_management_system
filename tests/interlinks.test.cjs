const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const cli = path.resolve(__dirname, '../out/research-maintenance.cjs');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlinks-'));
  for (const folder of ['assets', 'definitions']) fs.mkdirSync(path.join(root, 'research', folder), { recursive: true });
  fs.writeFileSync(path.join(root, '.research-assistant.json'), JSON.stringify({ research: {
    assets: 'research/assets', definitions: 'research/definitions',
  } }));
  const write = (folder, id, title, body, depends_on = [], uses_definitions = []) => {
    const type = folder === 'definitions' ? 'definition' : 'theorem';
    const raw = `---\ntype: ${type}\ntitle: "${title}"\nstatus: draft\ndepends_on: [${depends_on.join(', ')}]\nuses_definitions: [${uses_definitions.join(', ')}]\n---\n\n${body}\n`;
    fs.writeFileSync(path.join(root, 'research', folder, `${id}.md`), raw);
    return raw;
  };
  const read = (folder, id) => fs.readFileSync(path.join(root, 'research', folder, `${id}.md`), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, 'links', ...args, '--project', root], { encoding: 'utf8' });
  return { root, write, read, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('links repeated prose mentions from verified relationships without rewriting syntax', () => {
  const p = project();
  try {
    p.write('definitions', 'subgroup', '001. Definition (subgroup)', 'A subgroup is a group.');
    p.write('assets', 'lemma', '001. Subgroup Lemma', 'Lemma statement.');
    const before = p.write('assets', 'theorem', '002. Main Theorem',
      'A subgroup uses the Subgroup Lemma. Another subgroup uses the subgroup.\n\n`subgroup` $subgroup$ [subgroup](../definitions/subgroup.md)\n\n```text\nsubgroup\n```',
      ['lemma'], ['subgroup']);
    const preview = p.run('--preview');
    assert.equal(preview.status, 0);
    assert.match(preview.stdout, /LINK research\/assets\/theorem\.md: 4 occurrence\(s\)/);
    assert.equal(p.read('assets', 'theorem'), before);
    assert.equal(p.run('--apply').status, 0);
    const after = p.read('assets', 'theorem');
    assert.match(after, /A \[subgroup\]\(\.\.\/definitions\/subgroup\.md\) uses the \[Subgroup Lemma\]\(\.\/lemma\.md\)/);
    assert.match(after, /Another \[subgroup\]\(\.\.\/definitions\/subgroup\.md\) uses the \[subgroup\]\(\.\.\/definitions\/subgroup\.md\)/);
    assert.match(after, /`subgroup` \$subgroup\$ \[subgroup\]\(\.\.\/definitions\/subgroup\.md\)/);
    assert.match(after, /```text\nsubgroup\n```/);
    assert.match(p.run('--apply').stdout, /0 file\(s\) updated/);
  } finally { p.cleanup(); }
});

test('definition dependencies link within folder; missing relationships and targets are reported', () => {
  const p = project();
  try {
    p.write('definitions', 'group', '001. Definition (group)', 'A group is a set.');
    p.write('definitions', 'subgroup', '002. Definition (subgroup)', 'A subgroup is a group. Another group.', ['group']);
    p.write('assets', 'theorem', '001. Theorem', 'A subgroup is used.', ['missing']);
    const output = p.run('--preview');
    assert.equal(output.status, 0);
    assert.match(output.stdout, /LINK research\/definitions\/subgroup\.md: 2 occurrence\(s\)/);
    assert.match(output.stdout, /missing-relationship: subgroup -> definition\/subgroup/);
    assert.match(output.stdout, /missing-target: depends_on: missing/);
    assert.equal(p.run('--apply', '--file', 'research/definitions/subgroup.md').status, 0);
    assert.match(p.read('definitions', 'subgroup'), /A subgroup is a \[group\]\(\.\/group\.md\)\. Another \[group\]\(\.\/group\.md\)/);
    assert.match(p.read('assets', 'theorem'), /A subgroup is used\./);
  } finally { p.cleanup(); }
});

test('ambiguous names are not linked', () => {
  const p = project();
  try {
    p.write('definitions', 'group_one', 'Definition (group)', 'First group.');
    p.write('definitions', 'group_two', 'Definition (group)', 'Second group.');
    const before = p.write('assets', 'theorem', 'Theorem', 'A group occurs.', [], ['group_one']);
    const output = p.run('--apply');
    assert.equal(output.status, 0);
    assert.match(output.stdout, /ambiguous-term: group/);
    assert.equal(p.read('assets', 'theorem'), before);
  } finally { p.cleanup(); }
});

test('dashboard resolver accepts known relative node links and rejects external or escaping paths', () => {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../webview-src/researchLinks.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', built.outputFiles[0].text)(module, module.exports);
  const { resolveResearchNodeLink, resolvePaperPdfLink } = module.exports;
  const nodes = [
    { id: 'lemma', filePath: 'research/assets/lemma.md' },
    { id: 'subgroup', filePath: 'research/definitions/subgroup.md' },
  ];
  assert.equal(resolveResearchNodeLink('research/assets/theorem.md', './lemma.md', nodes)?.id, 'lemma');
  assert.equal(resolveResearchNodeLink('research/assets/theorem.md', '../definitions/subgroup.md', nodes)?.id, 'subgroup');
  assert.equal(resolveResearchNodeLink('research/assets/theorem.md', 'https://example.com', nodes), null);
  assert.equal(resolveResearchNodeLink('research/assets/theorem.md', '../../../outside.md', nodes), null);

  const paperFolder = 'research-local/raw_papers';
  assert.equal(resolvePaperPdfLink('research/assets/theorem.md', '../../research-local/raw_papers/lang_weil.pdf', paperFolder), `${paperFolder}/lang_weil.pdf`);
  assert.equal(resolvePaperPdfLink('research/definitions/group.md', '../../research-local/raw_papers/lang%20weil.pdf', paperFolder), `${paperFolder}/lang weil.pdf`);
  assert.equal(resolvePaperPdfLink('research/project.md', '../research-local/raw_papers/lang_weil.pdf', paperFolder), `${paperFolder}/lang_weil.pdf`);
  assert.equal(resolvePaperPdfLink('research/papers.md', '../research-local/raw_papers/lang_weil.pdf', paperFolder), `${paperFolder}/lang_weil.pdf`);
  assert.equal(resolvePaperPdfLink('research/assets/theorem.md', '../../private/pdfs/lang_weil.pdf', 'private/pdfs'), 'private/pdfs/lang_weil.pdf');
  assert.equal(resolvePaperPdfLink('research/assets/theorem.md', '../../elsewhere/lang_weil.pdf', paperFolder), null);
  assert.equal(resolvePaperPdfLink('research/assets/theorem.md', '../../research-local/raw_papers/nested/lang_weil.pdf', paperFolder), null);
  assert.equal(resolvePaperPdfLink('research/assets/theorem.md', '../../../research-local/raw_papers/lang_weil.pdf', paperFolder), null);
  assert.equal(resolvePaperPdfLink('research/assets/theorem.md', '../../research-local/raw_papers/%2e%2e/elsewhere.pdf', paperFolder), null);
  assert.equal(resolvePaperPdfLink('research/assets/theorem.md', 'https://example.com/lang_weil.pdf', paperFolder), null);
});

test('extension validates local PDF paths and reports missing files before opening them', async () => {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/services/PaperPdfPath.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  const { validatePaperPdfPath, requirePaperPdfPath } = module.exports;
  assert.equal(validatePaperPdfPath('research-local/raw_papers/lang weil.pdf', 'research-local/raw_papers'), 'research-local/raw_papers/lang weil.pdf');
  assert.equal(validatePaperPdfPath('private/pdfs/slug.pdf', 'private/pdfs'), 'private/pdfs/slug.pdf');
  assert.equal(validatePaperPdfPath('elsewhere/slug.pdf', 'private/pdfs'), null);
  assert.equal(validatePaperPdfPath('private/pdfs/sub/slug.pdf', 'private/pdfs'), null);
  assert.equal(validatePaperPdfPath('private/pdfs/../outside.pdf', 'private/pdfs'), null);
  assert.equal(validatePaperPdfPath('/private/pdfs/slug.pdf', 'private/pdfs'), null);
  assert.equal(await requirePaperPdfPath('private/pdfs/slug.pdf', 'private/pdfs', async () => true), 'private/pdfs/slug.pdf');
  await assert.rejects(requirePaperPdfPath('private/pdfs/missing.pdf', 'private/pdfs', async () => { throw new Error('ENOENT'); }), /Paper PDF not found/);
  await assert.rejects(requirePaperPdfPath('private/pdfs/sub/slug.pdf', 'private/pdfs', async () => true), /directly inside/);
});

test('dashboard preview renders research links and routes their clicks', () => {
  const built = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../webview-src/components/MarkdownPreview.tsx')],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'],
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  const { MarkdownPreview } = module.exports;
  const href = '../definitions/subgroup.md';
  const html = renderToStaticMarkup(React.createElement(MarkdownPreview, {
    content: `See [subgroup](${href}), [theorem](./theorem.md), and [source paper](../../research-local/raw_papers/lang_weil.pdf).`,
  }));
  assert.match(html, /<a href="\.\.\/definitions\/subgroup\.md">subgroup<\/a>/);
  assert.match(html, /<a href="\.\/theorem\.md">theorem<\/a>/);
  assert.match(html, /<a href="\.\.\/\.\.\/research-local\/raw_papers\/lang_weil\.pdf">source paper<\/a>/);
  assert.doesNotMatch(html, /node="\[object Object\]"/);

  const opened = [];
  const preview = MarkdownPreview({ content: '', onOpenNodeLink: (link) => { opened.push(link); return true; } });
  const renderAnchor = preview.props.children.props.components.a;
  const internal = renderAnchor({ href, children: 'subgroup', node: {} });
  let prevented = false;
  internal.props.onClick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened, [href]);

  const pdfHref = '../../research-local/raw_papers/lang_weil.pdf';
  const pdf = renderAnchor({ href: pdfHref, children: 'source paper', node: {} });
  prevented = false;
  pdf.props.onClick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened, [href, pdfHref]);

  const external = renderAnchor({ href: 'https://example.com', children: 'example', node: {} });
  prevented = false;
  external.props.onClick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.deepEqual(opened, [href, pdfHref]);
});

test('dashboard preview hides YAML frontmatter but keeps later horizontal rules', () => {
  const built = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../webview-src/components/MarkdownPreview.tsx')],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'],
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  const { MarkdownPreview } = module.exports;
  const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: >-\n      $G_0$ is nilpotent\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n---\n\nAfter a rule.\n';
  const html = renderToStaticMarkup(React.createElement(MarkdownPreview, { content: project }));
  assert.doesNotMatch(html, /type: project|required_results|main_theorem|schema_version/);
  assert.match(html, /<h1>Project<\/h1>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /After a rule\./);
});

test('a link already in the text needs the relationship a plain mention would', () => {
  const p = project();
  try {
    p.write('assets', 'lemma', '001. Bound Lemma', 'Lemma statement.');
    p.write('assets', 'theorem', '002. Main Theorem', 'By [Lemma 2.1](./lemma.md#statement), we have the bound. See also [outside](https://example.org/lemma.md).');
    const missing = p.run('--preview');
    assert.match(missing.stdout, /REVIEW research\/assets\/theorem\.md:\d+: missing-relationship: \[Lemma 2\.1\]\(\.\/lemma\.md#statement\) -> asset\/lemma/);
    assert.doesNotMatch(missing.stdout, /example\.org/);
    p.write('assets', 'theorem', '002. Main Theorem', 'By [Lemma 2.1](./lemma.md#statement), we have the bound.', ['lemma']);
    assert.doesNotMatch(p.run('--preview').stdout, /missing-relationship/);
  } finally { p.cleanup(); }
});
