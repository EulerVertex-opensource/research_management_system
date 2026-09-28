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

const { stopDecision, preToolUseDecision } = load('../src/services/ResearchLoopHooks.ts');
const { newState, stageSignature } = load('../src/services/ResearchLoopModel.ts');
const paths = { researchRoot: 'research', projectMd: 'research/project.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans' };

function running(patch = {}) {
  const state = newState('claude', 'run', '2026-01-01T00:00:00.000Z', 3);
  state.stage = 'plan';
  state.current.assetId = 'main_theorem';
  return Object.assign(state, patch);
}

test('Stop hook decision matrix', () => {
  assert.equal(stopDecision(undefined, {}, 'x').block, false);
  assert.equal(stopDecision(running({ status: 'paused' }), {}, 'x').block, false);
  assert.equal(stopDecision(running({ pendingQuestion: { id: 'q', kind: 'goals', prompt: '?', createdAt: '' } }), {}, 'x').block, false);
  assert.equal(stopDecision(running({ stage: 'waiting' }), {}, 'x').block, false);
  assert.equal(stopDecision(running({ stage: 'ready' }), {}, 'x').block, false);
  assert.equal(stopDecision(running({ stage: 'review_project' }), {}, 'x').block, false);
  const active = running();
  const decision = stopDecision(active, { session_id: 's' }, 'Do the plan stage.');
  assert.equal(decision.block, true);
  assert.match(decision.reason, /node \.agents\/skills\/research-loop\/scripts\/research-loop\.cjs next/);
  active.autopilot.sessions.s = { blocks: 3, lastSignature: '', lastBlockAt: '' };
  assert.equal(stopDecision(active, { session_id: 's' }, 'x').capReached, true);
  active.autopilot.sessions.s = { blocks: 1, lastSignature: stageSignature(active), lastBlockAt: '' };
  assert.equal(stopDecision(active, { session_id: 's', stop_hook_active: true }, 'x').block, false);
  assert.equal(stopDecision(active, { session_id: 's', stop_hook_active: false }, 'x').block, true);
});

test('PreToolUse denies approval forgery across Claude and Codex tool shapes', () => {
  const deny = (input) => preToolUseDecision(paths, input, '/repo').deny;
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: '/repo/research/assets/a.md', content: '---\nstatus: approved\n---\n' } }), true);
  assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: 'research/definitions/d.md', old_string: 'status: draft', new_string: 'status: approved' } }), true);
  assert.equal(deny({ tool_name: 'MultiEdit', tool_input: { file_path: 'research/assets/a.md', edits: [{ old_string: 'x', new_string: 'status: approved' }] } }), true);
  assert.equal(deny({ tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** Update File: research/assets/a.md\n@@\n-status: draft\n+status: approved\n*** End Patch' } }), true);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/approvals.json', content: '{}' } }), true);
  // Codex 0.153 sends apply_patch as { command: <patch> } (observed in a live run).
  assert.equal(deny({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: research/assets/lemma_a.md\n@@\n-status: draft\n+status: approved\n*** End Patch' } }), true);
  assert.equal(deny({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: research/project.md\n@@\n+## Main Problem\n*** End Patch' } }), false);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'echo x > .research-assistant-loop/state.json' } }), true);
  assert.equal(deny({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', "sed -i '' 's/status: draft/status: approved/' research/assets/a.md"] } }), true);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/assets/a.md', content: '---\nstatus: draft\n---\nfine' } }), false);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'notes/status.md', content: 'status: approved' } }), false);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'cat research/approvals.json' } }), false);
  assert.equal(deny({ tool_name: 'Read', tool_input: { file_path: 'research/approvals.json' } }), false);
});

const cli = path.resolve(__dirname, '../out/research-loop.cjs');
test('hook entry point blocks Stop while running and stays silent otherwise', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-hook-'));
  try {
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    write('research/project.md', '# Project\n');
    const hook = (event, input) => spawnSync(process.execPath, [cli, 'hook', event], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: 'sess', ...input }) });
    assert.equal(hook('Stop', {}).status, 0);
    assert.equal(hook('SessionStart', {}).stdout, '');
    assert.equal(spawnSync(process.execPath, [cli, 'start', '--provider', 'claude', '--goal', 'Prove', '--project', root, '--iteration-cap', '2'], { encoding: 'utf8' }).status, 0);
    const blocked = (result) => result.status === 0 && result.stdout.trim() !== '' && JSON.parse(result.stdout).decision === 'block';
    const first = hook('Stop', {});
    assert.equal(first.status, 0, first.stderr);
    assert.ok(blocked(first));
    assert.match(JSON.parse(first.stdout).reason, /draft_project/);
    const context = JSON.parse(hook('UserPromptSubmit', {}).stdout);
    assert.equal(context.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(context.hookSpecificOutput.additionalContext, /stage draft_project/);
    assert.equal(JSON.parse(hook('SessionStart', {}).stdout).hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(hook('Stop', { stop_hook_active: true }).stdout, ''); // no progress since the last block
    assert.ok(blocked(hook('Stop', {})));
    assert.equal(hook('Stop', {}).stdout, ''); // cap reached -> paused
    assert.match(fs.readFileSync(path.join(root, '.research-assistant-loop/state.json'), 'utf8'), /"status": "paused"/);
    const deny = hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'research/assets/a.md'), content: 'status: approved' } });
    assert.match(deny.stdout, /"permissionDecision":"deny"/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
