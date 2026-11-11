const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const matter = require('gray-matter');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { claimHolders, parseClaimLines, GitClaimTransport } = load('../src/services/Claims.ts');
const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { LoopGit } = load('../src/services/LoopGit.ts');
const { NodeGitRunner } = load('../src/cli/nodeGit.ts');

const event = (key, by, at, op = 'claim', machine = 'm1', lease = 24) => ({ key, by, machine, op, at, lease_hours: lease });

test('claims: the earliest live claim holds a unit; a release ends one; a lease lapses unless renewed', () => {
  const holders = claimHolders([
    event('plan:r1', 'bob', '2026-11-10T10:00:00Z'), event('plan:r1', 'alice', '2026-11-10T09:00:00Z'),
    event('lemma_a', 'alice', '2026-11-10T09:00:00Z'), event('lemma_a', 'alice', '2026-11-10T11:00:00Z', 'release'),
    event('lemma_b', 'carol', '2026-11-08T09:00:00Z'),
    event('lemma_c', 'dave', '2026-11-09T08:00:00Z'), event('lemma_c', 'dave', '2026-11-09T20:00:00Z'),
  ], '2026-11-10T12:00:00Z');
  assert.equal(holders.get('plan:r1').by, 'alice', 'earliest wins on every machine');
  assert.equal(holders.has('lemma_a'), false, 'released');
  assert.equal(holders.has('lemma_b'), false, 'lapsed');
  assert.equal(holders.get('lemma_c').since, '2026-11-09T08:00:00Z', 'a renewal keeps the original start');
  assert.deepEqual(parseClaimLines('{"key":"x","by":"a","op":"claim","at":"t"}\nnot json\n').map((item) => item.key), ['x']);
});

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: first_theorem\n  - id: second_theorem\n---\n\n## Main Problem\n\nProve both.\n\n## Scope and Assumptions\n\nN.\n\n## Intended Contribution\n\nC.\n\n## Background\n\nNone.\n';
const theorem = (title) => matter.stringify('\n## Statement\n\nFor every n, n = n.\n', { type: 'theorem', title, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [] });

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
    deleteFile: async (file) => { map.delete(file); },
  };
}

/** A claims branch shared in memory: each machine's file by name. */
function sharedBranch() {
  const branch = new Map();
  return (name) => ({ fetch: async () => [...branch].filter(([key]) => key !== name).map(([, text]) => text), push: async (text) => { branch.set(name, text); return true; } });
}

let counter = 0;
async function collaborator(identity, branch, clock) {
  const files = memoryFiles({
    'research/papers.md': '# Papers\n', 'research/project.md': project,
    'research/assets/first_theorem.md': theorem('First'), 'research/assets/second_theorem.md': theorem('Second'),
    '.research-assistant-loop/settings.json': JSON.stringify({ version: 1, routeWidth: 0, rigor: { refuteSearch: 'off', verifyProofs: 'off', verifyExtracted: 'off', agreeDefinitions: 'off', shareClaims: 'auto' } }),
  });
  const core = new ResearchLoopCore(files, paths, { id: () => `${identity}-${++counter}`, identity, now: clock, claimTransport: branch(identity) });
  await core.start('claude', {});
  await core.approve('project', 'project', 'test');
  return { files, core };
}

test('two collaborators: the loop claims what it starts, shares it at once, and the other loop works on something else', async () => {
  let now = Date.parse('2026-11-10T09:00:00Z');
  const clock = () => new Date(now += 1000).toISOString();
  const branch = sharedBranch();
  const alice = await collaborator('alice@example.edu', branch, clock);
  const bob = await collaborator('bob@example.edu', branch, clock);
  assert.equal((await alice.core.next()).stage, 'plan');
  assert.equal(alice.core.current.current.assetId, 'first_theorem');
  assert.ok((await alice.core.claims()).some((claim) => claim.key === 'first_theorem' && claim.by === 'alice@example.edu'));
  // Bob's loop fetches Alice's claim and passes over the first theorem.
  assert.equal((await bob.core.next()).stage, 'plan');
  assert.equal(bob.core.current.current.assetId, 'second_theorem');
  // Stopping releases Alice's claims: Bob's loop may take the first theorem afterwards.
  await alice.core.stop();
  await alice.core.refreshClaims(true);
  assert.deepEqual((await alice.core.claims()).map((claim) => claim.by), ['bob@example.edu'], 'only Bob\'s claim is left');
  await bob.core.refreshClaims(true);
  assert.deepEqual((await bob.core.claims()).map((claim) => claim.by), ['bob@example.edu']);
});

test('a collaborator\'s earlier claim on the unit this stage works on wins: the loop lets it go and chooses again', async () => {
  let now = Date.parse('2026-11-10T09:00:00Z');
  const clock = () => new Date(now += 1000).toISOString();
  const branch = sharedBranch();
  const alice = await collaborator('alice@example.edu', branch, clock);
  // Bob claimed the first theorem earlier, offline; his claim reaches Alice only now.
  await branch('bob@example.edu').push(JSON.stringify(event('first_theorem', 'bob@example.edu', '2026-11-10T08:00:00Z')) + '\n');
  // Alice's loop had already started on it before it fetched.
  const files = alice.files;
  files.map.set('.research-assistant-loop/claims-others.json', JSON.stringify({ fetchedAt: '2026-11-10T09:00:00Z', texts: [] }));
  const settings = JSON.parse(files.map.get('.research-assistant-loop/settings.json'));
  files.map.set('.research-assistant-loop/settings.json', JSON.stringify({ ...settings, rigor: { ...settings.rigor, shareClaims: 'publish' } }));
  assert.equal((await alice.core.next()).stage, 'plan');
  assert.equal(alice.core.current.current.assetId, 'first_theorem');
  await alice.core.refreshClaims(true);
  const next = await alice.core.next();
  assert.equal(next.stage, 'plan');
  assert.equal(alice.core.current.current.assetId, 'second_theorem', 'Bob holds the first theorem since 08:00');
});

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

test('the claims branch over git: each machine pushes only its own file, never touching the working tree; a lost race is rebuilt and retried', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-'));
  try {
    const origin = path.join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    const clone = (name) => {
      const dir = path.join(base, name);
      git(base, 'clone', '-q', origin, dir);
      git(dir, 'config', 'user.email', `${name}@example.edu`); git(dir, 'config', 'user.name', name); git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'README.md'), name); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
      return { dir, transport: new GitClaimTransport(new LoopGit(new NodeGitRunner(dir)), async () => 'origin', `${name}.jsonl`, async () => `${name}@example.edu`) };
    };
    const alice = clone('alice');
    const bob = clone('bob');
    const head = git(alice.dir, 'rev-parse', 'HEAD');
    assert.equal(await alice.transport.push('{"key":"plan:r1","by":"alice","op":"claim","at":"2026-11-10T09:00:00Z"}\n'), true);
    assert.equal(git(alice.dir, 'rev-parse', 'HEAD'), head, 'HEAD untouched');
    assert.equal(git(alice.dir, 'status', '--porcelain'), '', 'working tree untouched');
    // Bob pushes from a stale view (he never fetched): his push is rebuilt on Alice's tip.
    assert.equal(await bob.transport.push('{"key":"lemma_a","by":"bob","op":"claim","at":"2026-11-10T09:01:00Z"}\n'), true);
    const seenByAlice = await alice.transport.fetch();
    assert.equal(seenByAlice.length, 1);
    assert.match(seenByAlice[0], /lemma_a/);
    const seenByBob = await bob.transport.fetch();
    assert.match(seenByBob[0], /plan:r1/);
    assert.deepEqual(git(base, '--git-dir', origin, 'ls-tree', '--name-only', 'research-claims:claims').trim().split('\n').sort(), ['alice.jsonl', 'bob.jsonl']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('migration folds decision and handoff files into per-collaborator logs and moves search candidates out of git', async () => {
  const { migrateProject, migrationReasons } = load('../src/services/SchemaMigration.ts');
  const { readDecisions } = load('../src/services/RecordReader.ts');
  const decision = (kind, target, by, at, text) => matter.stringify(`\n${text}\n`, { type: 'decision', title: `x: ${target}`, kind, target, performed_by: by, created_at: at });
  const files = memoryFiles({
    'research/project.md': project, 'research/papers.md': '# Papers\n',
    'research/decisions/decision_a.md': decision('direction', 'first_theorem', 'alice@example.edu', '2026-10-02T10:00:00Z', 'Try induction.'),
    'research/decisions/decision_b.md': decision('parked', 'second_theorem', 'bob@example.edu', '2026-11-01T09:00:00Z', 'Unclear.'),
    'research/handoffs/handoff_c.md': matter.stringify('\n## Completed\n\n- Planned.\n', { type: 'handoff', title: 'Handoff', working_on: ['first_theorem'], performed_by: 'alice@example.edu', created_at: '2026-10-03T18:00:00Z' }),
    'research/candidates/cand_first_theorem_r1_s1_x.md': matter.stringify('\nA candidate.\n', { type: 'candidate', status: 'failed' }),
  });
  const before = (await readDecisions(files, 'research')).map((item) => [item.id, item.kind, item.target, item.text]).sort();
  assert.ok((await migrationReasons(files, paths)).some((reason) => /record logs/.test(reason)));
  const report = await migrateProject(files, paths, { now: '2026-11-10T00:00:00Z' });
  assert.ok(report.notes.some((note) => /Folded 3 decision and handoff file\(s\) into 2 record log\(s\)/.test(note)), report.notes.join('\n'));
  const logs = [...files.map.keys()].filter((file) => file.startsWith('research/log/')).sort();
  assert.deepEqual(logs, ['research/log/alice_example_edu__2026-10__migrated.jsonl', 'research/log/bob_example_edu__2026-11__migrated.jsonl']);
  assert.equal([...files.map.keys()].some((file) => file.startsWith('research/decisions/') || file.startsWith('research/handoffs/')), false);
  assert.deepEqual((await readDecisions(files, 'research')).map((item) => [item.id, item.kind, item.target, item.text]).sort(), before, 'the same decisions, read from the logs');
  assert.match(files.map.get(logs[0]), /"type":"handoff"[\s\S]*## Completed/);
  assert.ok(files.map.has('research-local/candidates/cand_first_theorem_r1_s1_x.md'));
  // Migrating again changes nothing.
  await migrateProject(files, paths, { now: '2026-11-10T00:00:00Z' });
  assert.equal(files.map.get(logs[0]).trim().split('\n').length, 2);
});
