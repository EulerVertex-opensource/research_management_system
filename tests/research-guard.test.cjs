const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'], external: ['vscode'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { NodeIndexService } = load('../src/services/NodeIndexService.ts');
const { guardDecision, GUARD_BLOCK_CAP } = load('../src/services/ResearchLoopHooks.ts');
const { buildPreCommitHook } = load('../src/services/AgentIntegrationCore.ts');
const { pathsFromConfigText } = load('../src/services/ProjectPathsCore.ts');

const cli = path.resolve(__dirname, '../out/research-loop.cjs');
const idea = (title) => `---\ntype: idea\ntitle: ${title}\nstatus: draft\n---\n\nbody\n`;
const config = JSON.stringify({ version: 1, layout: 'overleaf-shared', research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } });

function project(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const put = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
  return { root, put };
}

test('overlapping refreshes never report a node as clashing with itself, and the last one sees the latest files', async () => {
  const files = new Map([['research/ideas/idea_a.md', idea('A')], ['research/ideas/idea_b.md', idea('B')], ['research/ideas/idea_c.md', idea('C')]]);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const fileService = {
    listFiles: async (dir) => { await tick(); return [...files.keys()].filter((file) => path.posix.dirname(file) === dir); },
    readFile: async (file) => { await tick(); if (!files.has(file)) throw new Error('missing'); return files.get(file); },
    listDirs: async () => [],
    exists: async (file) => files.has(file),
  };
  const index = new NodeIndexService(fileService, pathsFromConfigText(config));
  const first = index.refresh();
  files.set('research/ideas/idea_d.md', idea('D'));
  const rest = [index.refresh(), index.refresh(), index.refresh()];
  await Promise.all([first, ...rest]);
  assert.deepEqual(index.getProblems(), []);
  assert.ok(index.getById('idea_d'), 'a refresh asked for during a scan runs again after it');
  assert.equal(index.getAll().length, 4);
});

test('guard decision: only problems new since the turn began send the agent back, at most the cap', () => {
  const start = guardDecision(undefined, ['old']);
  assert.equal(start.block, false);
  assert.deepEqual(start.record, { baseline: ['old'], blocks: 0 });
  assert.equal(guardDecision(start.record, ['old']).block, false);
  let record = start.record;
  for (let i = 0; i < GUARD_BLOCK_CAP; i += 1) {
    const decision = guardDecision(record, ['old', 'research/notes is outside the research layout']);
    assert.equal(decision.block, true);
    assert.match(decision.reason, /1 new problem\(s\)[\s\S]*- research\/notes is outside/);
    assert.doesNotMatch(decision.reason, /- old/);
    record = decision.record;
  }
  assert.equal(guardDecision(record, ['old', 'research/notes is outside the research layout']).block, false, 'the cap lets the turn end');
  assert.equal(guardDecision(record, ['old']).record.blocks, 0, 'a clean Stop resets the count');
});

test('the Stop hook sends any agent back for misplaced files this turn wrote, loop or not', () => {
  const { root, put } = project('research-guard-');
  try {
    put('.research-assistant.json', config);
    put('research/project.md', '# Project\n');
    put('research/ideas/idea_a.md', idea('A'));
    const hook = (event, input = {}) => spawnSync(process.execPath, [cli, 'hook', event], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: 'sess', ...input }) });
    const blocked = (result) => result.stdout.trim() !== '' && JSON.parse(result.stdout).decision === 'block';
    assert.equal(hook('UserPromptSubmit').stdout, '');
    // A script writes where no PreToolUse hook could see it.
    put('research/library/tromba_2012/sources/scan.txt', 'raw');
    const stop = hook('Stop');
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(blocked(stop));
    assert.match(JSON.parse(stop.stdout).reason, /research\/library\/tromba_2012\/sources is outside the research layout/);
    assert.match(JSON.parse(stop.stdout).reason, /research-maintenance\.cjs validate/);
    assert.ok(blocked(hook('Stop', { stop_hook_active: true })));
    assert.equal(hook('Stop', { stop_hook_active: true }).stdout, '', 'the cap lets the turn end');
    // Next turn: what was already wrong does not trap the agent.
    hook('UserPromptSubmit');
    assert.equal(hook('Stop').stdout, '');
    // A new session's first Stop has no baseline and never blocks.
    put('research/notes/raw.md', '# Notes\n');
    assert.equal(hook('Stop', { session_id: 'other' }).stdout, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the pre-commit hook refuses commits that add research problems and lets the rest through', () => {
  const { root: top, put } = project('research-precommit-');
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: top, encoding: 'utf8' });
    // The research project lives in a subfolder of the repository.
    put('paper/.research-assistant.json', config);
    put('paper/research/project.md', '# Project\n');
    put('paper/research/ideas/idea_a.md', idea('A'));
    const script = 'paper/.agents/skills/research-loop/scripts/research-loop.cjs';
    put(script, fs.readFileSync(cli, 'utf8'));
    put('.gitignore', '.agents/\n');
    git('init', '-q');
    fs.writeFileSync(path.join(top, '.git/hooks/pre-commit'), buildPreCommitHook('', script, 'paper'), { mode: 0o755 });
    assert.equal(git('add', '.').status, 0);
    const first = git('commit', '-qm', 'init');
    assert.equal(first.status, 0, first.stderr);

    put('paper/research/handoffs/notes_migration.json', '{}');
    put('paper/research/ideas/idea_b.md', idea('B'));
    git('add', '.');
    const refused = git('commit', '-qm', 'migration');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /would add 1 problem\(s\)[\s\S]*research\/handoffs\/notes_migration\.json/);
    assert.match(refused.stderr, /--no-verify/);

    // A problem already committed does not block an unrelated commit.
    assert.equal(git('commit', '-qm', 'migration', '--no-verify').status, 0);
    put('paper/research/ideas/idea_c.md', idea('C'));
    git('add', '.');
    const unrelated = git('commit', '-qm', 'idea');
    assert.equal(unrelated.status, 0, unrelated.stderr);

    // Only staged content counts: a misplaced file left unstaged does not block.
    put('paper/research/notes/raw.md', '# Notes\n');
    put('paper/research/ideas/idea_d.md', idea('D'));
    git('add', 'paper/research/ideas/idea_d.md');
    assert.equal(git('commit', '-qm', 'idea d').status, 0);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

test('the pre-commit hook file is managed only when it is the extension\'s own', () => {
  const hook = buildPreCommitHook('', '.agents/skills/research-loop/scripts/research-loop.cjs', '.');
  assert.match(hook, /^#!\/bin\/sh\n/);
  assert.match(hook, /exec node "\$script" precommit --project '\.'/);
  assert.equal(buildPreCommitHook(hook, '.agents/skills/research-loop/scripts/research-loop.cjs', '.'), hook);
  assert.equal(buildPreCommitHook('#!/bin/sh\nnpx lint-staged\n', 'x', '.'), undefined);
  assert.match(buildPreCommitHook('', "it's/x.cjs", "it's"), /script='it'\\''s\/x\.cjs'/);
});
