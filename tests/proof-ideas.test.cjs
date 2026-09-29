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

const cli = path.resolve(__dirname, '../out/research-maintenance.cjs');
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-ideas-'));
  for (const folder of ['assets', 'ideas', 'plans']) fs.mkdirSync(path.join(root, 'research', folder), { recursive: true });
  fs.writeFileSync(path.join(root, '.research-assistant.json'), JSON.stringify({ research: { assets: 'research/assets', ideas: 'research/ideas', plans: 'research/plans' } }));
  const file = (folder, id) => path.join(root, 'research', folder, `${id}.md`);
  const write = (folder, id, raw) => fs.writeFileSync(file(folder, id), raw);
  const read = (folder, id) => fs.readFileSync(file(folder, id), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, 'backlinks', ...args, '--project', root], { encoding: 'utf8' });
  const migrate = (...args) => spawnSync(process.execPath, [cli, 'migrate', ...args, '--project', root], { encoding: 'utf8' });
  const validate = () => spawnSync(process.execPath, [cli, 'validate', '--project', root], { encoding: 'utf8' });
  return { root, write, read, run, migrate, validate, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const asset = (name) => `---\ntype: theorem\ntitle: ${name}\nstatus: draft\n---\n\n## Statement\n\nProof text $x^2$.\n`;
const idea = (title, status, target, extra = '') => `---\ntype: idea\ntitle: ${title}\nstatus: ${status}\ntarget_asset: ${target}\n---\n\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\n## Plan\n\n1. [ ] Try a step.\n\n## Verification\n\nCheck it.\n${extra}`;
const direction = (title, status, related = [], body = 'A possible mathematical approach.\n') => `---\ntype: idea\ntitle: ${title}\nstatus: ${status}\nrelated_assets: [${related.join(', ')}]\n---\n\n${body}`;
const plan = (title, target, origins = []) => `---\ntype: plan\ntitle: ${title}\nstatus: pending\ntarget_asset: ${target}\ninspired_by: [${origins.join(', ')}]\n---\n\n## Goal\n\nTarget: [asset](../assets/${target}.md)\n\n## Plan\n\n1. [ ] Prove a concrete step.\n\n## Verification\n\nCheck the result.\n`;

test('plans and ideas store only forward relations; nothing is written into asset bodies', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    p.write('plans', 'attempt', plan('Attempt', 'a', ['hunch']));
    p.write('plans', 'blocked', plan('Blocked', 'a').replace('status: pending', 'status: failed') + '\n## Failure\n\nCounterexample.\n');
    p.write('plans', 'done', matter.stringify('\nTarget: [asset](../assets/a.md)\n\n## Outcome\n\nProof incorporated.\n', { type: 'plan', title: 'Done', status: 'succeeded', target_asset: 'a' }));
    p.write('ideas', 'hunch', direction('Hunch', 'resolved', ['a']));
    const before = p.read('assets', 'a');
    const result = p.validate();
    assert.equal(result.status, 0, result.stdout);
    assert.equal(p.read('assets', 'a'), before);
    assert.doesNotMatch(p.read('plans', 'attempt'), /research-assistant:/);
  } finally { p.cleanup(); }
});

test('validate reports broken idea and plan references and incomplete plans', () => {
  const p = project();
  try {
    p.write('assets', 'a', asset('A'));
    p.write('assets', 'gone', asset('Gone').replace('status: draft', 'status: deprecated'));
    p.write('assets', 'old_definition', '---\ntype: definition\ntitle: Old definition\nstatus: draft\n---\n\nDefinition text.\n');
    p.write('ideas', 'intuition', direction('Intuition', 'draft', ['a', 'missing_asset']));
    p.write('plans', 'unexplained', idea('Unexplained', 'failed', 'a'));
    p.write('plans', 'on_definition', idea('On definition', 'pending', 'old_definition'));
    p.write('plans', 'stale', idea('Stale', 'pending', 'gone'));
    p.write('plans', 'orphan', plan('Orphan', 'a', ['intuition', 'second_origin']));
    const result = p.validate();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ideas\/intuition\.md: related_assets contains a missing asset: missing_asset/);
    assert.match(result.stdout, /plans\/unexplained\.md: failed plan needs an obstruction under ## Failure/);
    assert.match(result.stdout, /plans\/on_definition\.md: target_asset is missing or does not name an asset/);
    assert.match(result.stdout, /plans\/stale\.md: pending plan targets deprecated asset gone; set it abandoned/);
    assert.match(result.stdout, /plans\/orphan\.md: inspired_by contains a missing idea: second_origin/);
    assert.doesNotMatch(result.stdout, /orphan\.md: inspired_by contains a missing idea: intuition/);
  } finally { p.cleanup(); }
});

test('node service creates and saves ideas and plans, including a succeeded plan, with valid backlinks', async () => {
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
    await assert.rejects(service.saveNode(created.id, { ...failed.frontmatter, status: 'succeeded' }, failed.body), /## Outcome/);
    await service.saveNode(created.id, { ...failed.frontmatter, status: 'succeeded' }, failed.body + '\n## Outcome\n\nProof incorporated in B.\n');
    assert.equal(matter(p.read('plans', created.id)).data.type, 'plan');
    assert.equal(matter(p.read('plans', created.id)).data.status, 'succeeded');
    assert.deepEqual(matter(p.read('plans', created.id)).data.inspired_by, [direction.id]);
    assert.equal(matter(p.read('plans', created.id)).data.kind, undefined);
    await service.refresh();
    assert.equal((await service.getNodeDetail(created.id)).frontmatter.status, 'succeeded');
    // Dashboard saves keep fields it does not edit and drop relations foreign to the node kind.
    fs.writeFileSync(path.join(p.root, 'research/assets/b.md'), asset('B').replace('status: draft', 'status: draft\norigin: seminar\nused_in: [a]'));
    await service.refresh();
    const assetDetail = await service.getNodeDetail('b');
    await service.saveNode('b', { ...assetDetail.frontmatter, related_assets: ['a'] }, assetDetail.body);
    const saved = matter(p.read('assets', 'b')).data;
    assert.equal(saved.origin, 'seminar');
    assert.equal(saved.used_in, undefined);
    assert.equal(saved.related_assets, undefined);
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
    { id: 'record', type: 'plan', title: 'Record', status: 'succeeded', filePath: 'research/plans/record.md', tags: [] },
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

test('migration moves legacy plans and records, rebases links, marks records succeeded, and is idempotent', () => {
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
    assert.doesNotMatch(p.read('assets', 'a'), /research-assistant:/);
    assert.equal(matter(p.read('plans', 'record')).data.type, 'plan');
    assert.equal(matter(p.read('plans', 'record')).data.status, 'succeeded');
    assert.equal(matter(p.read('ideas', 'origin')).data.kind, undefined);
    assert.equal(matter(p.read('ideas', 'origin')).data.idea_kind, 'approach');
    const before = p.read('plans', 'attempt');
    assert.match(p.migrate('--apply').stdout, /already uses the current schema/);
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
    assert.match(result.stderr, /already exists/);
    assert.equal(p.read('ideas', 'attempt'), legacy);
  } finally { p.cleanup(); }
});

test('uncertain legacy idea metadata is left intact by migration and reported by validate', () => {
  const p = project();
  try {
    const unclear = '---\ntype: idea\ntitle: Possible collapse argument\nstatus: pending\n---\n\nThe limit $G_0$ may guide the prelimit lattice argument.\n';
    p.write('ideas', 'unclear', unclear);
    p.write('ideas', 'legacy_plan', idea('Legacy', 'pending', 'missing_asset'));
    const result = p.migrate('--apply');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REVIEW .*unclear\.md: unsupported or uncertain idea metadata/);
    assert.equal(p.read('ideas', 'unclear'), unclear);
    const validation = p.validate();
    assert.equal(validation.status, 1);
    assert.match(validation.stdout, /research\/ideas\/unclear\.md: invalid idea/);
  } finally { p.cleanup(); }
});

test('the dashboard index marks a succeeded plan outdated once its target proof changes', async () => {
  const load = (entry) => {
    const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, entry)], bundle: true, write: false, platform: 'node', format: 'cjs' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
  };
  const { NodeIndexService } = load('../src/services/NodeIndexService.ts');
  const { proofDigest } = load('../src/services/ResearchLoopModel.ts');
  const p = project();
  try {
    fs.mkdirSync(path.join(p.root, 'research/definitions'));
    const proved = asset('A') + '\n## Proof\n\nOriginal proof.\n';
    p.write('assets', 'a', proved);
    p.write('plans', 'done', matter.stringify('\n## Outcome\n\nIn a.\n', { type: 'plan', title: 'Done', status: 'succeeded', target_asset: 'a', proof_digest: proofDigest(proved) }));
    const files = {
      listFiles: async (folder) => fs.existsSync(path.join(p.root, folder)) ? fs.readdirSync(path.join(p.root, folder)).map((name) => `${folder}/${name}`) : [],
      readFile: async (filePath) => fs.readFileSync(path.join(p.root, filePath), 'utf8'),
      writeFile: async (filePath, raw) => fs.writeFileSync(path.join(p.root, filePath), raw),
      exists: async (filePath) => fs.existsSync(path.join(p.root, filePath)),
    };
    const service = new NodeIndexService(files, { assets: 'research/assets', ideas: 'research/ideas', plans: 'research/plans', definitions: 'research/definitions' });
    assert.equal((await service.refresh()).find((node) => node.id === 'done').outdated, false);
    p.write('assets', 'a', proved.replace('Original proof.', 'Edited proof.'));
    assert.equal((await service.refresh()).find((node) => node.id === 'done').outdated, true);
  } finally { p.cleanup(); }
});
