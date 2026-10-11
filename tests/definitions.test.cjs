const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../out/research-maintenance.cjs');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'definitions-'));
  for (const folder of ['assets', 'definitions', 'ideas']) fs.mkdirSync(path.join(root, 'research', folder), { recursive: true });
  fs.writeFileSync(path.join(root, '.research-assistant.json'), JSON.stringify({ research: {
    assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas',
  } }));
  const write = (folder, id, type, title, status = 'draft', depends_on = [], extra = '') => {
    fs.writeFileSync(path.join(root, 'research', folder, `${id}.md`), `---\ntype: ${type}\ntitle: "${title}"\nstatus: ${status}\ndepends_on: [${depends_on.join(', ')}]\n${extra}---\n\nA mathematical statement.\n`);
  };
  const read = (folder, id) => fs.readFileSync(path.join(root, 'research', folder, `${id}.md`), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' });
  return { root, write, read, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('definitions are validated and listed in dependency order without renumbering titles', () => {
  const p = project();
  try {
    p.write('definitions', 'subgroup', 'definition', 'Definition (subgroup)');
    p.write('definitions', 'normal', 'definition', 'Definition (normal subgroup)', 'approved', ['subgroup']);
    p.write('definitions', 'group', 'definition', 'Definition (group)');
    const before = p.read('definitions', 'normal');
    const result = p.run('validate', '--definitions');
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /001 group — Definition \(group\)\n\s+002 subgroup — Definition \(subgroup\)\n\s+003 normal — Definition \(normal subgroup\)/);
    assert.equal(p.read('definitions', 'normal'), before);
  } finally { p.cleanup(); }
});

test('invalid definition dependencies are reported without writes', () => {
  for (const dependencies of [['missing'], ['a']]) {
    const p = project();
    try {
      p.write('definitions', 'a', 'definition', 'a', 'draft', dependencies);
      const before = p.read('definitions', 'a');
      assert.equal(p.run('validate', '--definitions').status, 1);
      assert.equal(p.read('definitions', 'a'), before);
    } finally { p.cleanup(); }
  }
});

test('migration moves definitions, converts explicit links, and retains approved status and body', () => {
  const p = project();
  try {
    p.write('assets', 'subgroup', 'definition', 'Subgroup', 'approved');
    p.write('assets', 'theorem', 'theorem', 'Theorem', 'approved', ['subgroup']);
    const original = p.read('assets', 'subgroup');
    const preview = p.run('migrate', '--preview');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /confirm it defines a concept/);
    assert.equal(p.read('assets', 'subgroup'), original);
    assert.equal(p.run('migrate', '--apply').status, 0);
    assert.equal(fs.existsSync(path.join(p.root, 'research/assets/subgroup.md')), false);
    assert.match(p.read('definitions', 'subgroup'), /status: approved/);
    assert.match(p.read('definitions', 'subgroup'), /A mathematical statement\./);
    assert.match(p.read('assets', 'theorem'), /uses_definitions:\n\s+- subgroup/);
    assert.match(p.read('assets', 'theorem'), /status: approved/);
    assert.match(p.run('migrate', '--preview').stdout, /already uses the current schema/);
  } finally { p.cleanup(); }
});

test('migration blocks collisions and unmappable definition dependencies without writes', () => {
  for (const collision of [true, false]) {
    const p = project();
    try {
      p.write('assets', 'd', 'definition', 'D', 'draft', collision ? [] : ['theorem']);
      if (collision) p.write('definitions', 'd', 'definition', 'Existing D');
      else p.write('assets', 'theorem', 'theorem', 'Theorem');
      const before = p.read('assets', 'd');
      assert.equal(p.run('migrate', '--apply').status, 1);
      assert.equal(p.read('assets', 'd'), before);
    } finally { p.cleanup(); }
  }
});
