const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const cli = path.resolve(__dirname, '../out/sync-proof-ideas.cjs');
const migrationCli = path.resolve(__dirname, '../out/migrate-idea-plans.cjs');
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-ideas-'));
  for (const folder of ['assets', 'ideas', 'plans']) fs.mkdirSync(path.join(root, 'research', folder), { recursive: true });
  fs.writeFileSync(path.join(root, '.research-assistant.json'), JSON.stringify({ research: { assets: 'research/assets', ideas: 'research/ideas', plans: 'research/plans' } }));
  const file = (folder, id) => path.join(root, 'research', folder, `${id}.md`);
  const write = (folder, id, raw) => fs.writeFileSync(file(folder, id), raw);
  const read = (folder, id) => fs.readFileSync(file(folder, id), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' });
  const migrate = (...args) => spawnSync(process.execPath, [migrationCli, ...args, '--project', root], { encoding: 'utf8' });
  return { root, write, read, run, migrate, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const asset = (name) => `---\ntype: theorem\ntitle: ${name}\nstatus: draft\n---\n\n## Statement\n\nProof text $x^2$.\n`;
const idea = (title, status, target, extra = '') => `---\ntype: idea\ntitle: ${title}\nstatus: ${status}\ntarget_asset: ${target}\n---\n\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\n## Plan\n\n1. [ ] Try a step.\n\n## Verification\n\nCheck it.\n${extra}`;
const direction = (title, status, related = [], body = 'A possible mathematical approach.\n') => `---\ntype: idea\ntitle: ${title}\nstatus: ${status}\nrelated_assets: [${related.join(', ')}]\n---\n\n${body}`;
const plan = (title, target, origins = []) => `---\ntype: plan\ntitle: ${title}\nstatus: pending\ntarget_asset: ${target}\ninspired_by: [${origins.join(', ')}]\n---\n\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\n## Plan\n\n1. [ ] Prove a concrete step.\n\n## Verification\n\nCheck the result.\n`;

test('asset lists track pending, failed, reassigned, deleted, and completed attempts without changing proof text', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    p.write('assets', 'b', asset('B'));
    p.write('plans', 'attempt', idea('Attempt', 'pending', 'a'));
    p.write('plans', 'blocked', idea('Blocked', 'failed', 'a', '\n## Failure\n\nCounterexample.\n'));
    assert.equal(p.run('--preview').status, 0);
    assert.doesNotMatch(p.read('assets', 'a'), /Proof plans/);
    assert.equal(p.run('--apply').status, 0);
    assert.match(p.read('assets', 'a'), /### Pending\n\n- \[Attempt\]\(\.\.\/plans\/attempt\.md\)/);
    assert.match(p.read('assets', 'a'), /### Failed\n\n- \[Blocked\]\(\.\.\/plans\/blocked\.md\)/);
    assert.match(p.read('assets', 'a'), /Proof text \$x\^2\$\./);
    const unchanged = p.read('assets', 'a');
    assert.match(p.run('--apply').stdout, /0 file\(s\) updated/);
    assert.equal(p.read('assets', 'a'), unchanged);
    p.write('plans', 'attempt', idea('Attempt', 'pending', 'b'));
    fs.unlinkSync(path.join(p.root, 'research/plans/blocked.md'));
    assert.equal(p.run('--apply').status, 0);
    assert.doesNotMatch(p.read('assets', 'a'), /\[Attempt\]|\[Blocked\]/);
    assert.match(p.read('assets', 'b'), /\[Attempt\]/);
    p.write('plans', 'attempt', matter.stringify('\nTarget: [asset](../assets/b.md)\n\n## Outcome\n\nProof incorporated.\n', { type: 'proof_record', title: 'Attempt', target_asset: 'b' }));
    assert.equal(p.run('--apply').status, 0);
    assert.match(p.read('assets', 'b'), /### Proof records\n\n- \[Attempt\]/);
  } finally { p.cleanup(); }
});

test('legacy draft ideas are treated as freeform directions without rewriting their prose', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    const legacy = '---\ntype: idea\ntitle: Old thought\nstatus: draft\nrelated_assets: [a]\n---\n\nOriginal mathematical note.\n';
    p.write('ideas', 'legacy', legacy);
    p.write('plans', 'valid', idea('Valid', 'pending', 'a'));
    const run = p.run('--apply');
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.match(p.read('ideas', 'legacy'), /Original mathematical note\./);
    assert.match(p.read('ideas', 'legacy'), /## Related assets\n\n- \[A\]\(\.\.\/assets\/a\.md\)/);
    assert.match(p.read('assets', 'a'), /\[Valid\]/);
    assert.match(p.read('assets', 'a'), /### Draft directions\n\n- \[Old thought\]/);
  } finally { p.cleanup(); }
});

test('incomplete failed attempts are reported instead of presented as documented failures', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    p.write('plans', 'failed_without_reason', idea('Unexplained', 'failed', 'a'));
    const run = p.run('--apply');
    assert.match(run.stderr, /Failure explanation/);
    assert.doesNotMatch(p.read('assets', 'a'), /\[Unexplained\]/);
  } finally { p.cleanup(); }
});

test('legacy definition files in the asset folder are not treated as proof targets', () => {
  const p = project();
  try {
    const definition = '---\ntype: definition\ntitle: Old definition\nstatus: draft\n---\n\nDefinition text.\n';
    p.write('assets', 'old_definition', definition);
    p.write('plans', 'attempt', idea('Attempt', 'pending', 'old_definition'));
    const run = p.run('--apply');
    assert.match(run.stderr, /target_asset is missing or does not name an asset/);
    assert.equal(p.read('assets', 'old_definition'), definition);
  } finally { p.cleanup(); }
});

test('directions may link zero or many assets, keep freeform mathematics, and move between draft and archived lists', () => {
  const p = project();
  try {
    for (const id of ['cfg', 'kernel', 'classification', 'lens']) p.write('assets', id, asset(id));
    const mathematics = 'The limit group $G_0$ is abelian.\n\nUse Cheeger--Fukaya--Gromov and Zassenhaus/Margulis ideas.\n\nDo not infer injectivity of the entire local lattice.\n';
    p.write('ideas', 'toral_collapse', direction('Prelimit toral collapse', 'draft', ['cfg', 'kernel', 'classification', 'lens'], mathematics));
    p.write('ideas', 'unattached', direction('Unattached feeling', 'draft'));
    assert.equal(p.run('--apply').status, 0);
    for (const id of ['cfg', 'kernel', 'classification', 'lens']) {
      assert.match(p.read('assets', id), /### Draft directions\n\n- \[Prelimit toral collapse\]/);
      assert.match(p.read('ideas', 'toral_collapse'), new RegExp(`\\[${id}\\]\\(\\.\\.\\/assets\\/${id}\\.md\\)`));
    }
    assert.match(p.read('ideas', 'toral_collapse'), /Do not infer injectivity of the entire local lattice\./);
    assert.doesNotMatch(p.read('ideas', 'unattached'), /Related assets/);
    const before = p.read('ideas', 'toral_collapse');
    assert.match(p.run('--apply').stdout, /0 file\(s\) updated/);
    assert.equal(p.read('ideas', 'toral_collapse'), before);
    p.write('ideas', 'toral_collapse', direction('Prelimit toral collapse', 'archived', ['cfg', 'lens'], mathematics));
    assert.equal(p.run('--apply').status, 0);
    assert.match(p.read('assets', 'cfg'), /### Archived directions\n\n- \[Prelimit toral collapse\]/);
    assert.doesNotMatch(p.read('assets', 'kernel'), /\[Prelimit toral collapse\]/);
    assert.doesNotMatch(p.read('ideas', 'toral_collapse'), /classification\.md/);
    assert.match(p.read('ideas', 'toral_collapse'), /The limit group \$G_0\$ is abelian\./);
  } finally { p.cleanup(); }
});

test('several plans cite one direction, and missing origins are reported without hiding valid plans', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    p.write('ideas', 'intuition', direction('Intuition', 'draft', ['a']));
    p.write('ideas', 'second_origin', direction('Second origin', 'draft'));
    p.write('plans', 'first_plan', plan('First plan', 'a', ['intuition', 'second_origin']));
    p.write('plans', 'second_plan', plan('Second plan', 'a', ['intuition']));
    assert.equal(p.run('--apply').status, 0);
    assert.match(p.read('plans', 'first_plan'), /## Inspired by\n\n- \[Intuition\]\(\.\.\/ideas\/intuition\.md\)\n- \[Second origin\]\(\.\.\/ideas\/second_origin\.md\)/);
    assert.match(p.read('assets', 'a'), /\[First plan\]/);
    assert.match(p.read('assets', 'a'), /\[Second plan\]/);
    fs.unlinkSync(path.join(p.root, 'research/ideas/second_origin.md'));
    const run = p.run('--apply');
    assert.match(run.stderr, /missing direction: second_origin/);
    assert.doesNotMatch(p.read('plans', 'first_plan'), /second_origin\.md/);
    assert.match(p.read('plans', 'first_plan'), /\[Intuition\]/);
    assert.match(p.read('assets', 'a'), /\[First plan\]/);
  } finally { p.cleanup(); }
});

test('node service creates and saves proof ideas and successful records with valid backlinks', async () => {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/services/NodeIndexService.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  const { NodeIndexService } = module.exports;
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    p.write('assets', 'b', asset('B'));
    const files = {
      listFiles: async (folder) => fs.readdirSync(path.join(p.root, folder)).map((name) => `${folder}/${name}`),
      readFile: async (filePath) => fs.readFileSync(path.join(p.root, filePath), 'utf8'),
      writeFile: async (filePath, raw) => fs.writeFileSync(path.join(p.root, filePath), raw),
      exists: async (filePath) => fs.existsSync(path.join(p.root, filePath)),
    };
    const service = new NodeIndexService(files, { assets: 'research/assets', ideas: 'research/ideas', plans: 'research/plans', definitions: 'research/definitions' });
    fs.mkdirSync(path.join(p.root, 'research/definitions'));
    await service.refresh();
    const direction = await service.createNode('idea', 'Explore collapse');
    assert.equal(direction.type, 'idea');
    assert.equal(direction.status, 'draft');
    assert.equal(matter(p.read('ideas', direction.id)).data.target_asset, undefined);
    const directionDetail = await service.getNodeDetail(direction.id);
    await service.saveNode(direction.id, { ...directionDetail.frontmatter, status: 'archived', related_assets: ['a', 'b'] }, 'A feeling involving $G_0$ and short kernel elements.');
    assert.equal(matter(p.read('ideas', direction.id)).data.status, 'archived');
    assert.deepEqual(matter(p.read('ideas', direction.id)).data.related_assets, ['a', 'b']);
    assert.match(p.read('ideas', direction.id), /A feeling involving \$G_0\$/);
    await assert.rejects(service.createNode('plan', 'Try a proof'), /target asset/);
    const created = await service.createNode('plan', 'Try a proof', 'a');
    assert.equal(created.type, 'plan');
    assert.equal(created.status, 'pending');
    assert.match(p.read('plans', created.id), /Target: \[asset\]\(\.\.\/assets\/a\.md\)/);
    const detail = await service.getNodeDetail(created.id);
    await service.saveNode(created.id, { ...detail.frontmatter, target_asset: 'b', status: 'failed', inspired_by: [direction.id] }, detail.body + '\n## Failure\n\nCounterexample.\n');
    assert.match(p.read('plans', created.id), /Target: \[asset\]\(\.\.\/assets\/b\.md\)/);
    await service.refresh();
    const failed = await service.getNodeDetail(created.id);
    await service.saveNode(created.id, { ...failed.frontmatter, type: 'proof_record', status: undefined }, failed.body + '\n## Outcome\n\nProof incorporated in B.\n');
    assert.equal(matter(p.read('plans', created.id)).data.status, undefined);
    assert.deepEqual(matter(p.read('plans', created.id)).data.inspired_by, [direction.id]);
    assert.equal(matter(p.read('plans', created.id)).data.kind, undefined);
    await service.refresh();
    assert.equal((await service.getNodeDetail(created.id)).frontmatter.type, 'proof_record');
  } finally { p.cleanup(); }
});

test('dashboard separates ideas and plans and allows ideas without an asset', () => {
  function load(entry) {
    const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, entry)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'] });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
  }
  const { NodeList } = load('../webview-src/components/NodeList.tsx');
  const { CreateNodeModal } = load('../webview-src/components/CreateNodeModal.tsx');
  const nodes = [
    { id: 'a', type: 'theorem', title: 'A', status: 'draft', filePath: 'research/assets/a.md', tags: [] },
    { id: 'attempt', type: 'plan', title: 'Attempt', status: 'pending', filePath: 'research/plans/attempt.md', tags: [] },
    { id: 'direction', type: 'idea', title: 'Direction', status: 'draft', filePath: 'research/ideas/direction.md', tags: [] },
    { id: 'record', type: 'proof_record', title: 'Record', filePath: 'research/plans/record.md', tags: [] },
  ];
  const list = renderToStaticMarkup(React.createElement(NodeList, { nodes, selectedId: null, onSelect: () => {}, filterType: 'idea' }));
  assert.doesNotMatch(list, /Attempt/);
  assert.match(list, /Direction/);
  assert.doesNotMatch(list, /Record/);
  const plansList = renderToStaticMarkup(React.createElement(NodeList, { nodes, selectedId: null, onSelect: () => {}, filterType: 'plan' }));
  assert.match(plansList, /Attempt/);
  assert.match(plansList, /Record/);
  assert.doesNotMatch(plansList, /Direction/);
  assert.doesNotMatch(list, />A<\/div>/);
  const modal = renderToStaticMarkup(React.createElement(CreateNodeModal, { allowedTypes: ['idea'], assets: [nodes[0]], onConfirm: () => {}, onCancel: () => {} }));
  assert.match(modal, /Idea/);
  assert.doesNotMatch(modal, /Proof plan/);
  assert.doesNotMatch(modal, /Target asset/);
  assert.match(modal, /disabled=""[^>]*>Create/);
});

test('migration moves legacy plans and records, rebases links, and is idempotent', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    const origin = '---\ntype: idea\nkind: direction\ntitle: Toral collapse\nstatus: draft\nrelated_assets: [a]\n---\n\nThe limit group $G_0$ is abelian.\n\n[Attempt](./attempt.md) may help.\n';
    const legacyPlan = '---\ntype: idea\nkind: proof_plan\ntitle: Attempt\nstatus: pending\ntarget_asset: a\ninspired_by: [origin]\n---\n\n## Goal\n\nTarget: [asset](../assets/a.md)\n\n## Plan\n\n1. [ ] Establish a bound using [the idea](./origin.md).\n\n## Verification\n\nCheck the bound.\n';
    p.write('ideas', 'origin', origin);
    p.write('ideas', 'attempt', legacyPlan);
    p.write('ideas', 'record', '---\ntype: proof_record\ntitle: Old proof\ntarget_asset: a\n---\n\nTarget: [asset](../assets/a.md)\n\n## Outcome\n\nProof in asset.\n');
    assert.equal(p.migrate('--preview').status, 0);
    assert.equal(p.read('ideas', 'attempt'), legacyPlan);
    assert.equal(p.migrate('--apply').status, 0);
    assert.equal(fs.existsSync(path.join(p.root, 'research/ideas/attempt.md')), false);
    assert.equal(fs.existsSync(path.join(p.root, 'research/ideas/record.md')), false);
    assert.equal(matter(p.read('plans', 'attempt')).data.type, 'plan');
    assert.equal(matter(p.read('plans', 'attempt')).data.kind, undefined);
    assert.match(p.read('plans', 'attempt'), /\[the idea\]\(\.\.\/ideas\/origin\.md\)/);
    assert.match(p.read('ideas', 'origin'), /\[Attempt\]\(\.\.\/plans\/attempt\.md\)/);
    assert.match(p.read('ideas', 'origin'), /The limit group \$G_0\$ is abelian\./);
    assert.match(p.read('assets', 'a'), /\[Old proof\]\(\.\.\/plans\/record\.md\)/);
    const before = p.read('plans', 'attempt');
    assert.match(p.migrate('--apply').stdout, /0 file\(s\) updated/);
    assert.equal(p.read('plans', 'attempt'), before);
  } finally { p.cleanup(); }
});

test('migration refuses plan ID collisions before changing files', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    const legacy = idea('Legacy', 'pending', 'a');
    p.write('ideas', 'attempt', legacy);
    p.write('plans', 'attempt', plan('Existing', 'a'));
    const result = p.migrate('--apply');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destination exists/);
    assert.equal(p.read('ideas', 'attempt'), legacy);
  } finally { p.cleanup(); }
});

test('migration reports uncertain legacy metadata and leaves mathematical notes intact', () => {
  const p = project();
  try {
    const unclear = '---\ntype: idea\ntitle: Possible collapse argument\nstatus: pending\n---\n\nThe limit $G_0$ may guide the prelimit lattice argument.\n';
    p.write('ideas', 'unclear', unclear);
    const result = p.migrate('--apply');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported or uncertain idea metadata/);
    assert.equal(p.read('ideas', 'unclear'), unclear);
  } finally { p.cleanup(); }
});
