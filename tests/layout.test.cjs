const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { preToolUseDecision } = load('../src/services/ResearchLoopHooks.ts');
const { pathsFromConfigText } = load('../src/services/ProjectPathsCore.ts');
const paths = pathsFromConfigText(JSON.stringify({ research: { library: 'research/library' } }));
const node = '---\ntype: theorem\ntitle: T\nstatus: draft\n---\n\nStatement.\n';
const deny = (input, exists) => preToolUseDecision(paths, input, '/repo', exists);
const write = (file_path, content = node) => ({ tool_name: 'Write', tool_input: { file_path, content } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('the hook denies folder notes, subfolders, and new folders under the research root', () => {
  for (const input of [
    write('research/assets/topology/hidden_thm.md'),
    write('/repo/research/assets/README.md', '# Assets\n'),
    write('research/assets/index.md', '# Index of results\n'),
    write('research/notes/overview.md', '# Overview\n'),
    write('research/overview.md', '# Overview\n'),
    write('research/library/smith2021/smith2021.md', '# Smith\n'),
    write('research/library/smith2021/assets/compact.md'),
    write('research/papers/smith2021/notes.md', '# Notes\n'),
    { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: research/topics/geometry.md\n+# Geometry\n*** End Patch' } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: research/ideas/index.md\n+# Ideas index\n*** End Patch' } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: research/ideas/a.md\n*** Move to: research/ideas/old/a.md\n@@\n-x\n+x\n*** End Patch' } },
    bash('mkdir -p research/notes'),
    bash('mkdir research/assets/topology'),
    bash("cat > research/notes/summary.md <<'EOF'\n# Summary\nEOF"),
    bash('python3 organize.py --out research/topics/algebra.md'),
  ]) {
    const decision = deny(input);
    assert.equal(decision.deny, true, JSON.stringify(input));
    assert.match(decision.reason, /^Research layout: /);
  }
  assert.match(deny(write('research/assets/README.md', '# x\n')).reason, /folder notes are not allowed/);
  assert.match(deny(write('research/assets/topology/a.md')).reason, /research\/assets\/ is flat/);
});

test('the hook allows every configured place and anything outside the research root', () => {
  for (const input of [
    write('research/assets/main_theorem.md'),
    write('research/definitions/compact_set.md'),
    write('research/ideas/try_induction.md', '---\ntype: idea\ntitle: x\nstatus: draft\n---\nbody\n'),
    write('research/plans/plan_main.md', '---\ntype: plan\n---\n'),
    write('research/checks/check_main_small.md', '---\ntype: falsification_check\n---\n'),
    write('research/project.md', '# Project\n'),
    write('research/papers.md', '# Papers\n'),
    write('research/papers/smith2021/paper.md', '> transcription\n'),
    write('research/papers/smith2021/metadata.yaml', 'slug: smith2021\n'),
    write('research/papers/smith2021/figures/fig1.png', ''),
    write('research/library/smith2021/collection.md', '# Smith 2021\n'),
    write('research/library/smith2021/assets/lib_compact.md'),
    write('research/writing/outline.md', '# Outline\n'),
    write('research/writing/sections/introduction.md', '# Intro\n'),
    write('main.tex', '\\documentclass{amsart}'),
    write('sections/intro.tex', 'x'),
    write('figures/plot.pdf', ''),
    write('research-local/raw_papers/smith2021.pdf', ''),
    write('research-local/ocr/page1.txt', ''),
    { tool_name: 'Edit', tool_input: { file_path: 'research/notes/old.md', old_string: 'a', new_string: 'b' } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Delete File: research/notes/old.md\n*** End Patch' } },
    bash('mkdir -p research/papers/smith2021/figures research-local/raw_papers'),
    bash('node .agents/skills/research-maintenance/scripts/research-maintenance.cjs links --apply'),
  ]) assert.equal(deny(input).deny, false, JSON.stringify(input));
});

test('shell commands may still read, move, and delete a misplaced file that already exists', () => {
  const exists = (relative) => relative === 'research/notes/raw.md' || relative === 'research/notes';
  assert.equal(deny(bash('python3 extract.py research/notes/raw.md > /tmp/out.txt'), exists).deny, false);
  assert.equal(deny(bash('mv research/notes/raw.md research/ideas/raw_idea.md'), exists).deny, false);
  assert.equal(deny(bash('rm -r research/notes'), exists).deny, false);
  assert.equal(deny(bash('mv research/notes/raw.md research/notes/new.md'), exists).deny, true);
});

test('shell copies and moves are checked where they land, folders included', () => {
  const exists = (relative) => ['research/library/tromba_2012', 'research/handoffs', 'research/ideas', 'research/notes'].includes(relative);
  for (const command of [
    'cp -r raw research/library/tromba_2012/sources',
    'mv research-local/raw research/library/tromba_2012/',
    'git mv notes_migration.json research/handoffs/',
    'mkdir -p tmp && cp -t research/ideas notes.txt',
  ]) {
    const decision = deny(bash(command), exists);
    assert.equal(decision.deny, true, command);
    assert.match(decision.reason, /^Research layout: /);
  }
  for (const command of [
    'mv research/notes research-local/old_notes',
    'cp draft.md research/ideas/',
    'git mv research/ideas/a.md research/ideas/b.md',
    'rsync -a research/ backup:research/',
  ]) assert.equal(deny(bash(command), exists).deny, false, command);
});

test('with the legacy root `.` only the configured folders are governed', () => {
  const legacy = pathsFromConfigText(JSON.stringify({ layout: 'legacy' }));
  const check = (input) => preToolUseDecision(legacy, input, '/repo').deny;
  assert.equal(check(write('manuscript/main.tex', 'x')), false);
  assert.equal(check(write('notes.md', '# Notes\n')), false);
  assert.equal(check(write('assets/main_theorem.md')), false);
  assert.equal(check(write('assets/topology/a.md')), true);
  assert.equal(check(write('assets/README.md', '# x\n')), true);
});

const maintenance = path.resolve(__dirname, '../out/research-maintenance.cjs');
test('validate reports misplaced files once per folder, notes legacy leftovers, and ignores dotfiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));
  try {
    const put = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    put('.research-assistant.json', '{}');
    put('research/ideas/good.md', '---\ntype: idea\ntitle: x\nstatus: draft\n---\nbody\n');
    put('research/assets/topology/topology.md', '# Topology\n');
    put('research/assets/topology/hidden_thm.md', node);
    put('research/notes/notes.md', '# Notes\n');
    put('research/library/smith2021/smith2021.md', '# Smith\n');
    put('research/overview.md', '# Overview\n');
    put('research/workflows/old.md', 'x');
    put('research/.DS_Store', '');
    put('research/papers/smith2021/paper.md', 'x');
    const clean = () => spawnSync(process.execPath, [maintenance, 'validate', '--project', root], { encoding: 'utf8' });
    const result = clean();
    assert.equal(result.status, 1);
    const problems = result.stdout.split('\n').filter((line) => line.startsWith('PROBLEM'));
    assert.equal(problems.length, 4, result.stdout);
    assert.match(result.stdout, /PROBLEM research\/assets\/topology: research\/assets\/ is flat/);
    assert.match(result.stdout, /PROBLEM research\/notes is outside the research layout/);
    assert.match(result.stdout, /PROBLEM research\/library\/smith2021\/smith2021\.md is outside the research layout/);
    assert.match(result.stdout, /PROBLEM research\/overview\.md is outside the research layout/);
    assert.match(result.stdout, /NOTE research\/workflows\/ is left from an older version/);
    put('research/assets/index.md', '# Index\n');
    assert.match(clean().stdout, /research\/assets\/index\.md: not a research node \(no frontmatter\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const loop = path.resolve(__dirname, '../out/research-loop.cjs');
test('the Stop hook links the asset and definition files the agent changed, and only those', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autolink-'));
  try {
    const put = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    const asset = (title, body, uses) => `---\ntype: theorem\ntitle: ${title}\nstatus: draft\nuses_definitions: [${uses}]\n---\n\n${body}\n`;
    put('.research-assistant.json', '{}');
    put('research/definitions/subgroup.md', '---\ntype: definition\ntitle: Definition (subgroup)\nstatus: draft\n---\n\nA subgroup is a group.\n');
    put('research/assets/old_result.md', asset('Old result', 'Every subgroup is fine.', 'subgroup'));
    git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    put('research/assets/new_result.md', asset('New result', 'Each subgroup is closed.', 'subgroup'));
    const stop = spawnSync(process.execPath, [loop, 'hook', 'Stop'], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: 's' }) });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(stop.stdout, '');
    assert.match(read('research/assets/new_result.md'), /Each \[subgroup\]\(\.\.\/definitions\/subgroup\.md\) is closed\./);
    assert.equal(read('research/assets/old_result.md'), asset('Old result', 'Every subgroup is fine.', 'subgroup'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
