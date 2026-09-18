const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../out/order-assets.cjs');

function fixture(nodes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-order-'));
  const assets = path.join(root, 'research', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(root, '.research-assistant.json'), JSON.stringify({ research: { assets: 'research/assets' } }));
  for (const [id, { title = id, status = 'draft', depends_on = [] }] of Object.entries(nodes)) {
    fs.writeFileSync(path.join(assets, `${id}.md`), `---\ntype: theorem\ntitle: ${title}\nstatus: ${status}\ndepends_on: [${depends_on.join(', ')}]\n---\n\nBody.\n`);
  }
  return { root, assets, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(root, flag) {
  return spawnSync(process.execPath, [cli, flag, '--project', root], { encoding: 'utf8' });
}

test('orders chains and branches, previews safely, and becomes a no-op', () => {
  const project = fixture({
    z: { title: 'Z', depends_on: ['b'] },
    b: { title: 'B', depends_on: ['a'] },
    a: { title: 'A' },
    c: { title: 'C', depends_on: ['a'] },
    x: { title: 'X', status: 'archived' },
  });
  try {
    const before = fs.readFileSync(path.join(project.assets, 'a.md'), 'utf8');
    assert.equal(run(project.root, '--preview').status, 0);
    assert.equal(fs.readFileSync(path.join(project.assets, 'a.md'), 'utf8'), before);
    assert.equal(run(project.root, '--apply').status, 0);
    const titles = Object.fromEntries(['a', 'b', 'c', 'z', 'x'].map((id) => [id, /^title: (.*)$/m.exec(fs.readFileSync(path.join(project.assets, `${id}.md`), 'utf8'))?.[1].replace(/^"|"$/g, '')]));
    assert.match(titles.a, /^001\. A/);
    assert.match(titles.b, /^002\. B/);
    assert.match(titles.c, /^003\. C/);
    assert.match(titles.z, /^004\. Z/);
    assert.equal(titles.x, 'X');
    assert.match(run(project.root, '--apply').stdout, /0 title change\(s\)/);
    fs.writeFileSync(path.join(project.assets, 'aa.md'), '---\ntype: theorem\ntitle: AA\nstatus: draft\ndepends_on: [a]\n---\n');
    assert.equal(run(project.root, '--apply').status, 0);
    assert.match(fs.readFileSync(path.join(project.assets, 'aa.md'), 'utf8'), /title: "002\. AA"/);
  } finally { project.cleanup(); }
});

test('missing, inactive, and cyclic dependencies leave files untouched', () => {
  for (const nodes of [
    { a: { depends_on: ['missing'] } },
    { a: { depends_on: ['b'] }, b: { status: 'archived' } },
    { a: { depends_on: ['b'] }, b: { depends_on: ['a'] } },
  ]) {
    const project = fixture(nodes);
    try {
      const before = fs.readdirSync(project.assets).map((id) => fs.readFileSync(path.join(project.assets, id), 'utf8'));
      assert.equal(run(project.root, '--apply').status, 1);
      assert.deepEqual(fs.readdirSync(project.assets).map((id) => fs.readFileSync(path.join(project.assets, id), 'utf8')), before);
    } finally { project.cleanup(); }
  }
});
