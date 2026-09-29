const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../out/research-maintenance.cjs');

function fixture(nodes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-order-'));
  const assets = path.join(root, 'research', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(root, '.research-assistant.json'), JSON.stringify({ research: { assets: 'research/assets' } }));
  for (const [id, { title = id, status = 'draft', depends_on = [] }] of Object.entries(nodes)) {
    fs.writeFileSync(path.join(assets, `${id}.md`), `---\ntype: theorem\ntitle: ${title}\nstatus: ${status}\ndepends_on: [${depends_on.join(', ')}]\n---\n\nBody.\n`);
  }
  const snapshot = () => fs.readdirSync(assets).sort().map((file) => fs.readFileSync(path.join(assets, file), 'utf8'));
  return { root, assets, snapshot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const validate = (root, ...args) => spawnSync(process.execPath, [cli, 'validate', ...args, '--project', root], { encoding: 'utf8' });

test('validate prints chains and branches in dependency order without touching titles', () => {
  const project = fixture({
    z: { title: 'Z', depends_on: ['b'] },
    b: { title: 'B', depends_on: ['a'] },
    a: { title: 'A' },
    c: { title: 'C', depends_on: ['a'] },
    x: { title: 'X', status: 'archived' },
  });
  try {
    const before = project.snapshot();
    const result = validate(project.root, '--assets');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /001 a — A\n\s+002 b — B\n\s+003 c — C\n\s+004 z — Z\n/);
    assert.doesNotMatch(result.stdout, / x — /);
    assert.deepEqual(project.snapshot(), before);
    fs.writeFileSync(path.join(project.assets, 'aa.md'), '---\ntype: theorem\ntitle: AA\nstatus: draft\ndepends_on: [a]\n---\n\nBody.\n');
    assert.match(validate(project.root, '--assets').stdout, /001 a — A\n\s+002 aa — AA\n/);
  } finally { project.cleanup(); }
});

test('missing, inactive, and cyclic dependencies are reported and leave files untouched', () => {
  for (const [nodes, problem] of [
    [{ a: { depends_on: ['missing'] } }, /depends on missing asset missing\.md/],
    [{ a: { depends_on: ['b'] }, b: { status: 'archived' } }, /depends on inactive asset b\.md \(archived\)/],
    [{ a: { depends_on: ['b'] }, b: { depends_on: ['a'] } }, /Dependency cycle involving: a, b/],
  ]) {
    const project = fixture(nodes);
    try {
      const before = project.snapshot();
      const result = validate(project.root);
      assert.equal(result.status, 1);
      assert.match(result.stdout, problem);
      assert.deepEqual(project.snapshot(), before);
    } finally { project.cleanup(); }
  }
});

test('validate reports IDs reused across research folders and schema problems', () => {
  const project = fixture({ lemma: { title: 'Lemma' } });
  try {
    fs.mkdirSync(path.join(project.root, 'research', 'ideas'), { recursive: true });
    fs.writeFileSync(path.join(project.root, 'research', 'ideas', 'lemma.md'), '---\ntype: idea\ntitle: Same ID\nstatus: draft\n---\n\nA thought.\n');
    fs.writeFileSync(path.join(project.assets, 'odd.md'), '---\ntype: theorem\ntitle: Odd\nstatus: draft\nsource:\n  kind: rumour\n---\n\nBody.\n');
    const result = validate(project.root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /research\/ideas\/lemma\.md: node ID lemma is already used by research\/assets\/lemma\.md/);
    assert.match(result.stdout, /research\/assets\/odd\.md: source\.kind must be one of paper, textbook, original, note/);
  } finally { project.cleanup(); }
});
