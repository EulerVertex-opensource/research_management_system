const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const matter = require('gray-matter');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { researchDigest, statementDigest } = load('../src/services/ResearchLoopModel.ts');
const { autoPullDecision, syncNowAction } = load('../src/services/ResearchSync.ts');
const { defaultLatexCommand } = load('../src/services/ProjectPathsCore.ts');
const cli = path.resolve(__dirname, '../out/research-loop.cjs');

const config = { version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } };
const project = '# Project\n\n## Main Problem\n\nProve A.\n\n## Current Goals\n\nFind a proof.\n\n## Required Results\n\n- main_theorem: the central claim\n';
const theorem = (statement = 'For every weak solution u, u = u.', extra = {}) => matter.stringify(`\n## Statement\n\n${statement}\n`, { type: 'theorem', title: 'Main theorem', status: 'draft', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: ['weak_solution'], tags: [], ...extra });
const definition = (text = 'A weak solution is a distribution satisfying the equation.', status = 'approved') => matter.stringify(`\n${text}\n`, { type: 'definition', title: 'Weak solution', status, depends_on: [], tags: [] });
const { candidate, roundRecord } = require('./search-fixtures.cjs');
/** One refute worker's result for round 1: a failed candidate and the round record. */
const SEARCH_FILES = { 'research/candidates/cand_main_theorem_r1_s1_constants.md': candidate(), 'research/checks/search_main_theorem_r1_constants.md': roundRecord('main_theorem', 'Constant solutions satisfy the equation trivially.') };
const approval = (kind, target, raw) => JSON.stringify({ kind, target, digest: researchDigest(raw, kind), approvedAt: '2026-09-01T00:00:00Z', source: 'test', ...(kind === 'project' ? {} : { statement: statementDigest(raw) }) }, null, 2) + '\n';

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function team() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'research-sync-'));
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = (name) => {
    const dir = path.join(base, name);
    git(base, 'clone', '-q', origin, dir);
    git(dir, 'config', 'user.email', `${name}@example.edu`);
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'checkout', '-q', '-B', 'main');
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true }); fs.writeFileSync(path.join(dir, relative), content); };
    const read = (relative) => fs.readFileSync(path.join(dir, relative), 'utf8');
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
    const commit = (message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); };
    return { dir, write, read, run, commit, git: (...args) => git(dir, ...args), state: () => JSON.parse(read('.research-assistant-loop/state.json')) };
  };
  const alice = clone('alice');
  alice.write('.research-assistant.json', JSON.stringify(config, null, 2));
  alice.write('.gitignore', '/.research-assistant-loop/\n/research-local/\n');
  alice.write('research/project.md', project);
  alice.write('research/papers.md', '# Papers\n');
  alice.write('references.bib', '% refs\n');
  alice.write('research/definitions/weak_solution.md', definition());
  alice.write('research/assets/main_theorem.md', theorem());
  alice.write('research/approvals/project.json', approval('project', 'project', project));
  alice.write('research/approvals/definitions/weak_solution.json', approval('definition', 'weak_solution', definition()));
  alice.commit('initial research');
  alice.git('push', '-q', '-u', 'origin', 'main');
  const bob = clone('bob');
  return { base, origin, alice, bob, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('sync pull summarizes collaborators\' research, invalidates stale approvals, and rebuilds shared loop state', () => {
  const t = team();
  try {
    const { alice, bob } = t;
    assert.equal(bob.run(['start', '--provider', 'claude']).status, 0);
    assert.equal(bob.state().stage, 'search');
    // Alice parks the theorem with a reason and tightens the definition the theorem depends on.
    assert.equal(alice.run(['start', '--provider', 'codex']).status, 0);
    assert.equal(alice.run(['park', 'main_theorem', '--reason', 'assumption A3 unclear']).status, 0);
    const approvedTheorem = theorem(undefined, { status: 'approved' });
    alice.write('research/assets/main_theorem.md', approvedTheorem);
    alice.write('research/approvals/assets/main_theorem.json', approval('asset', 'main_theorem', approvedTheorem));
    alice.commit('approve theorem');
    alice.git('push', '-q');
    assert.equal(bob.run(['sync', 'pull']).status, 0);
    alice.write('research/definitions/weak_solution.md', definition('A weak solution is an H^1 function satisfying the equation.'));
    alice.commit('tighten weak solution');
    alice.git('push', '-q');

    const pulled = bob.run(['sync', 'pull']);
    assert.equal(pulled.status, 0, pulled.stderr + pulled.stdout);
    assert.match(pulled.stdout, /Definition weak_solution: statement changed/);
    assert.match(pulled.stdout, /Approval of main_theorem invalidated \(dependency weak_solution\)/);
    assert.match(bob.read('research/assets/main_theorem.md'), /status: draft/);
    const state = bob.state();
    assert.equal(state.parked.main_theorem.reason, 'assumption A3 unclear');
    assert.equal(state.status, 'running');
    assert.equal(JSON.parse(bob.read('.research-assistant-loop/sync.json')).phase, 'idle');
    const decisions = fs.readdirSync(path.join(bob.dir, 'research/decisions'));
    assert.ok(decisions.some((file) => file.includes('_parked_main_theorem_')));
    assert.match(bob.read(`research/decisions/${decisions[0]}`), /performed_by: alice@example.edu/);
  } finally { t.cleanup(); }
});

test('a raw git pull during a stage is not attributed to the agent; sync pull --continue re-baselines', () => {
  const t = team();
  try {
    const { alice, bob } = t;
    assert.equal(bob.run(['start', '--provider', 'claude']).status, 0);
    assert.equal(bob.state().stage, 'search');
    alice.write('research/ideas/idea_alice.md', matter.stringify('\nTry a compactness argument.\n', { type: 'idea', title: 'Compactness', status: 'draft', origin: 'researcher', related_assets: ['main_theorem'] }));
    alice.commit('idea');
    alice.git('push', '-q');
    bob.git('pull', '-q', '--rebase');
    for (const [file, content] of Object.entries(SEARCH_FILES)) bob.write(file, content);
    const report = bob.run(['report', 'searched', '--summary', 'No counterexample']);
    assert.equal(report.status, 1);
    assert.match(report.stderr, /HEAD moved .* research\/ideas\/idea_alice\.md .*alice@example\.edu/s);
    for (const file of Object.keys(SEARCH_FILES)) fs.rmSync(path.join(bob.dir, file));
    const rebased = bob.run(['sync', 'pull', '--continue']);
    assert.equal(rebased.status, 0, rebased.stderr);
    assert.equal(bob.state().stage, 'search');
    for (const [file, content] of Object.entries(SEARCH_FILES)) bob.write(file, content);
    const again = bob.run(['report', 'searched', '--summary', 'No counterexample']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(bob.state().stage, 'plan');
    assert.equal(matter(bob.read('research/candidates/cand_main_theorem_r1_s1_constants.md')).data.performed_by, 'bob@example.edu');
    const checkFile = fs.readdirSync(path.join(bob.dir, 'research/checks')).find((file) => file.startsWith('check_main_theorem_'));
    assert.match(bob.read(`research/checks/${checkFile}`), /Constant solutions satisfy the equation trivially/);
    const stamped = matter(bob.read(`research/checks/${checkFile}`)).data;
    assert.equal(stamped.performed_by, 'bob@example.edu');
    assert.equal(stamped.statement_digest, statementDigest(bob.read('research/assets/main_theorem.md')));
    assert.ok(stamped.base_commit);
  } finally { t.cleanup(); }
});

test('conflicting statement edits stop the pull without choosing a side; --continue finishes after the researcher resolves', () => {
  const t = team();
  try {
    const { alice, bob } = t;
    alice.write('research/assets/main_theorem.md', theorem('For every weak solution u on a bounded domain, u = u.'));
    alice.commit('alice statement');
    alice.git('push', '-q');
    bob.write('research/assets/main_theorem.md', theorem('For every weak solution u with finite energy, u = u.'));
    bob.commit('bob statement');
    assert.equal(bob.run(['start', '--provider', 'claude']).status, 0);
    const pulled = bob.run(['sync', 'pull']);
    assert.equal(pulled.status, 1, pulled.stderr);
    assert.match(pulled.stdout, /Conflicts with origin\/main in: research\/assets\/main_theorem\.md/);
    assert.match(bob.read('research/assets/main_theorem.md'), /<<<<<<< /);
    assert.equal(bob.state().status, 'paused');
    assert.match(bob.run(['sync', 'pull']).stderr, /stopped on conflicts/);
    assert.match(bob.run(['sync', 'pull', '--continue']).stderr, /not finished/);
    bob.write('research/assets/main_theorem.md', theorem('For every weak solution u on a bounded domain with finite energy, u = u.'));
    bob.git('add', 'research/assets/main_theorem.md');
    spawnSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: bob.dir });
    const resumed = bob.run(['sync', 'pull', '--continue']);
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    assert.match(resumed.stdout, /main_theorem: statement changed/);
    assert.equal(bob.state().status, 'running');
  } finally { t.cleanup(); }
});

function fakeExtension(dir, answer) {
  const token = 'test-token';
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      calls.push({ auth: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ confirmed: answer }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    fs.mkdirSync(path.join(dir, '.research-assistant-loop'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.research-assistant-loop/bridge.json'), JSON.stringify({ port: server.address().port, token, pid: process.pid }));
    resolve({ calls, close: () => new Promise((done) => server.close(done)) });
  }));
}

function runAsync(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('prepare checks sources and approvals; publish needs the researcher\'s confirmation and commits only research paths', async () => {
  const t = team();
  try {
    const { alice, bob } = t;
    // The researcher edits by hand with no stage in progress (a running stage would count these as unreported edits).
    bob.write('research/assets/cited_lemma.md', matter.stringify('\n## Statement\n\nA cited bound.\n', { type: 'lemma', title: 'Cited bound', status: 'draft', source: { kind: 'paper', paper_id: 'smith_2024', location: 'Theorem 2.1' }, depends_on: [], uses_definitions: [] }));
    bob.write('notes.txt', 'private scratch\n');
    const failing = bob.run(['sync', 'prepare', '--no-fetch']);
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /FAIL Sources cited.*\n.*smith_2024, which is not in research\/papers\.md/);
    bob.write('research/papers.md', '# Papers\n\n## smith_2024\n\nSource: https://arxiv.org/abs/2401.00001\n');
    bob.write('references.bib', '% refs\n@article{smith_2024,\n  title={Bounds},\n}\n');
    // Upstream moves meanwhile: publish must integrate it and re-validate before pushing.
    alice.write('research/ideas/idea_alice.md', matter.stringify('\nTry compactness.\n', { type: 'idea', title: 'Compactness', status: 'draft', origin: 'researcher', related_assets: [] }));
    alice.commit('alice idea');
    alice.git('push', '-q');
    const prepared = bob.run(['sync', 'prepare']);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.match(prepared.stdout, /Ready to share/);
    assert.match(prepared.stdout, /WARN Upstream has no newer commits/);
    assert.match(prepared.stdout, /New draft lemma cited_lemma/);
    const handoff = prepared.stdout.match(/Handoff written: (\S+)/)[1];
    assert.match(bob.read(handoff), /type: handoff/);

    const refused = bob.run(['sync', 'publish']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /needs the researcher's confirmation/);
    assert.equal(git(t.origin, 'rev-list', '--count', 'main'), '2');

    const declined = await fakeExtension(bob.dir, false);
    const cancelled = await runAsync(bob.dir, ['sync', 'publish']);
    await declined.close();
    assert.match(cancelled.stdout, /cancelled/);
    assert.equal(declined.calls[0].body.name, 'confirm_publish');
    assert.match(declined.calls[0].body.arguments.detail, /research\/assets\/cited_lemma\.md/);

    bob.write('research/assets/cited_lemma.md', bob.read('research/assets/cited_lemma.md').replace('A cited bound.', 'A sharper cited bound.'));
    assert.match(bob.run(['sync', 'publish']).stderr, /changed after sync prepare/);
    assert.equal(bob.run(['sync', 'prepare', '--no-fetch']).status, 0);

    const accepted = await fakeExtension(bob.dir, true);
    const published = await runAsync(bob.dir, ['sync', 'publish']);
    await accepted.close();
    assert.equal(published.status, 0, published.stderr + published.stdout);
    assert.match(published.stdout, /Integrated origin\/main before pushing/);
    assert.match(published.stdout, /Published [0-9a-f]{8} to origin main/);
    const message = git(t.origin, 'log', '-1', '--format=%B', 'main');
    assert.match(message, /Research-Handoff: research\/handoffs\/handoff_/);
    const shipped = git(t.origin, 'show', '--name-only', '--format=', 'main').split('\n');
    assert.ok(shipped.includes('research/assets/cited_lemma.md'));
    assert.ok(!shipped.includes('notes.txt'));
    assert.ok(git(t.origin, 'ls-tree', '-r', '--name-only', 'main').includes('research/ideas/idea_alice.md'));
    assert.ok(fs.existsSync(path.join(bob.dir, 'notes.txt')));
    assert.equal(bob.git('status', '--porcelain', '--', 'research'), '');
  } finally { t.cleanup(); }
});

test('legacy approvals.json splits into per-target files that merge without conflicts', () => {
  const t = team();
  try {
    const { alice, bob } = t;
    alice.git('rm', '-q', '-r', 'research/approvals');
    alice.write('research/approvals.json', JSON.stringify({ version: 1, records: [JSON.parse(approval('project', 'project', project)), JSON.parse(approval('definition', 'weak_solution', definition()))] }));
    alice.commit('legacy approvals');
    alice.git('push', '-q');
    bob.git('pull', '-q');
    const migrated = bob.run(['migrate-approvals']);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.ok(!fs.existsSync(path.join(bob.dir, 'research/approvals.json')));
    assert.equal(JSON.parse(bob.read('research/approvals/definitions/weak_solution.json')).target, 'weak_solution');
    bob.commit('split approvals');
    bob.git('push', '-q');
    alice.git('pull', '-q');
    // Two collaborators approve different results in parallel; separate files merge cleanly.
    const lemma = matter.stringify('\n## Statement\n\nA lemma.\n', { type: 'lemma', title: 'Lemma', status: 'approved', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [] });
    alice.write('research/assets/lemma_a.md', lemma);
    alice.write('research/approvals/assets/lemma_a.json', approval('asset', 'lemma_a', lemma));
    alice.commit('approve lemma_a');
    alice.git('push', '-q');
    bob.write('research/assets/lemma_b.md', lemma);
    bob.write('research/approvals/assets/lemma_b.json', approval('asset', 'lemma_b', lemma));
    bob.commit('approve lemma_b');
    assert.equal(bob.run(['start', '--provider', 'claude']).status, 0);
    const pulled = bob.run(['sync', 'pull']);
    assert.equal(pulled.status, 0, pulled.stderr + pulled.stdout);
    assert.match(pulled.stdout, /Approval of asset lemma_a recorded/);
    assert.ok(fs.existsSync(path.join(bob.dir, 'research/approvals/assets/lemma_b.json')));
  } finally { t.cleanup(); }
});

test('auto-pull pulls only when the clone is clean and the loop is idle; otherwise it notifies', () => {
  const t = team();
  try {
    const { alice, bob } = t;
    const status = () => { const result = bob.run(['sync', 'status', '--json']); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
    assert.deepEqual(autoPullDecision(status(), 'pull'), { action: 'none' });
    alice.write('main.tex', '\\documentclass{article}\\begin{document}Edited on Overleaf.\\end{document}\n');
    alice.commit('overleaf edit');
    alice.git('push', '-q');
    const behind = status();
    assert.equal(behind.behind, 1);
    assert.deepEqual(autoPullDecision(behind, 'pull'), { action: 'pull' });
    assert.equal(autoPullDecision(behind, 'notify').action, 'notify');
    assert.deepEqual(autoPullDecision(behind, 'off'), { action: 'none' });
    assert.deepEqual(autoPullDecision({ ...behind, fetchError: 'auth failed' }, 'pull'), { action: 'none' });
    assert.deepEqual(autoPullDecision({ ...behind, phase: 'conflict' }, 'pull'), { action: 'none' });
    assert.match(autoPullDecision({ ...behind, loop: { status: 'running' } }, 'pull').reason, /loop is running/);
    bob.write('research/ideas/idea_local.md', matter.stringify('\nLocal note.\n', { type: 'idea', title: 'Local', status: 'draft', origin: 'researcher' }));
    assert.match(autoPullDecision(status(), 'pull').reason, /uncommitted/);
    fs.rmSync(path.join(bob.dir, 'research/ideas/idea_local.md'));
    assert.equal(bob.run(['sync', 'pull']).status, 0);
    assert.match(bob.read('main.tex'), /Edited on Overleaf/);
    assert.deepEqual(autoPullDecision(status(), 'pull'), { action: 'none' });
  } finally { t.cleanup(); }
});

test('the dashboard Sync button shares local work, otherwise pulls, and stops where a person must act', () => {
  const t = team();
  try {
    const { alice, bob } = t;
    const status = () => { const result = bob.run(['sync', 'status', '--json']); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
    assert.deepEqual(syncNowAction(status()), { action: 'none' });
    alice.write('main.tex', '\\documentclass{article}\\begin{document}Edited on Overleaf.\\end{document}\n');
    alice.commit('overleaf edit');
    alice.git('push', '-q');
    const behind = status();
    assert.deepEqual(syncNowAction(behind), { action: 'pull' });
    bob.write('research/ideas/idea_local.md', matter.stringify('\nLocal note.\n', { type: 'idea', title: 'Local', status: 'draft', origin: 'researcher' }));
    // Local work wins: publish commits it, then integrates the upstream commit before pushing.
    assert.deepEqual(syncNowAction(status()), { action: 'share' });
    assert.deepEqual(syncNowAction({ ...behind, uncommitted: [], ahead: 2 }), { action: 'share' });
    assert.deepEqual(syncNowAction({ ...behind, uncommitted: [], upstreamMissing: true }), { action: 'share' });
    assert.equal(syncNowAction({ ...behind, phase: 'conflict', conflicted: ['main.tex'] }).action, 'blocked');
    assert.match(syncNowAction({ ...behind, phase: 'conflict', conflicted: ['main.tex'] }).reason, /main\.tex/);
    assert.match(syncNowAction({ ...behind, fetchError: 'auth failed' }).reason, /credentials/);
    assert.match(syncNowAction({ ...behind, unreportedStageEdits: ['research/assets/a.md'] }).reason, /middle of a research step/);
  } finally { t.cleanup(); }
});

test('the LaTeX check defaults to latexmk on the configured main file, writing to the root .latex-out', () => {
  assert.equal(defaultLatexCommand(config.latex), 'latexmk -pdf -interaction=nonstopmode -halt-on-error -cd -outdir=.latex-out main.tex');
  assert.equal(defaultLatexCommand({ ...config.latex, projectRoot: 'manuscript', main: 'paper.tex' }), 'latexmk -pdf -interaction=nonstopmode -halt-on-error -cd -outdir=../.latex-out manuscript/paper.tex');
  assert.match(defaultLatexCommand({ ...config.latex, main: 'my paper.tex' }), / 'my paper\.tex'$/);
});
