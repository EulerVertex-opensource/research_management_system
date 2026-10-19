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
const { nextAgentActivity } = load('../src/services/AgentActivity.ts');
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

test('PreToolUse protects split approvals, shared decision records, and raw git history commands', () => {
  const deny = (input) => preToolUseDecision(paths, input, '/repo').deny;
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/approvals/assets/main_theorem.json', content: '{}' } }), true);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: '/repo/research/decisions/decision_x.md', content: 'x' } }), true);
  assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: 'research/handoffs/handoff_x.md', old_string: 'a', new_string: 'b' } }), true);
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: 'research/checks/check_main_theorem_small.md', content: '---\ntype: falsification_check\n---\n' } }), false);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), true);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'cd repo && git pull --rebase' } }), true);
  assert.equal(deny({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'git -C /repo merge origin/main'] } }), true);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'git status && git diff' } }), false);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'git checkout -- research/assets/a.md' } }), false);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'node .agents/skills/research-loop/scripts/research-loop.cjs sync pull' } }), false);
});

test('agent activity: turns open and end, a command in flight is tracked, tool hooks are throttled', () => {
  const t = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const open = nextAgentActivity(undefined, { kind: 'active', sessionId: 's' }, t(0));
  assert.deepEqual(open, { turn: 'open', at: t(0), sessionId: 's' });
  assert.equal(nextAgentActivity(open, { kind: 'active', sessionId: 's', throttle: true }, t(10)), undefined);
  assert.equal(nextAgentActivity(open, { kind: 'active', sessionId: 's', throttle: true }, t(40)).at, t(40));
  const shell = nextAgentActivity(open, { kind: 'active', sessionId: 's', tool: { name: 'Bash', phase: 'start' }, throttle: true }, t(5));
  assert.deepEqual(shell.tool, { name: 'Bash', startedAt: t(5) });
  assert.deepEqual(nextAgentActivity(shell, { kind: 'active', throttle: false }, t(6)).tool, shell.tool, 'other activity keeps the command in flight');
  assert.equal(nextAgentActivity(shell, { kind: 'active', sessionId: 's', tool: { name: 'Bash', phase: 'end' }, throttle: true }, t(7)).tool, undefined);
  const ended = nextAgentActivity(shell, { kind: 'ended', by: 'stop', sessionId: 's' }, t(8));
  assert.deepEqual(ended, { turn: 'ended', at: t(8), endedBy: 'stop', sessionId: 's' });
  assert.equal(nextAgentActivity(open, { kind: 'ended', by: 'session_end', sessionId: 'other' }, t(9)), undefined, 'another chat closing is not the driver ending');
  assert.equal(nextAgentActivity(open, { kind: 'ended', by: 'session_end', sessionId: 's' }, t(9)).endedBy, 'session_end');
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
    const agent = () => JSON.parse(fs.readFileSync(path.join(root, '.research-assistant-loop/agent.json'), 'utf8'));
    assert.equal(agent().turn, 'open');
    assert.equal(hook('Stop', { stop_hook_active: true }).stdout, ''); // no progress since the last block
    assert.deepEqual([agent().turn, agent().endedBy], ['ended', 'stop'], 'handing back is recorded, not counted as activity');
    hook('UserPromptSubmit', {});
    assert.equal(agent().turn, 'open');
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 1' } });
    assert.equal(agent().tool.name, 'Bash');
    hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 1' } });
    assert.equal(agent().tool, undefined);
    hook('SessionEnd', { session_id: 'someone-else' });
    assert.equal(agent().turn, 'open');
    hook('SessionEnd', {});
    assert.deepEqual([agent().turn, agent().endedBy], ['ended', 'session_end']);
    assert.ok(blocked(hook('Stop', {})));
    assert.equal(agent().turn, 'open', 'a Stop that sends the agent on keeps the turn open');
    assert.equal(hook('Stop', {}).stdout, ''); // cap reached -> paused
    assert.match(fs.readFileSync(path.join(root, '.research-assistant-loop/state.json'), 'utf8'), /"status": "paused"/);
    const deny = hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'research/assets/a.md'), content: 'status: approved' } });
    assert.match(deny.stdout, /"permissionDecision":"deny"/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stale driver copy never rewrites loop state; restore-approvals repairs what an old driver reverted', () => {
  const crypto = require('node:crypto');
  const matter = require('gray-matter');
  const { researchDigest, statementDigest } = (() => {
    const esbuild = require('esbuild');
    const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/services/ResearchLoopModel.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
  })();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-stale-'));
  try {
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
    write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    write('research/project.md', '# Project\n\n## Main Problem\n\nProve A.\n\n## Required Results\n\n- lemma_a: the lemma\n');
    const approved = matter.stringify('\n## Statement\n\nA lemma.\n', { type: 'lemma', title: 'Lemma', status: 'approved', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [] });
    write('research/assets/lemma_a.md', approved);
    write('research/approvals/assets/lemma_a.json', JSON.stringify({ kind: 'asset', target: 'lemma_a', digest: researchDigest(approved, 'asset'), statement: statementDigest(approved), approvedAt: 'then', source: 'popup' }));
    const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root, input });
    assert.equal(run(['start', '--provider', 'codex']).status, 0);

    // The extension ships a different driver than the copy the hooks run.
    write('.research-assistant-loop/driver.json', JSON.stringify({ sha256: crypto.createHash('sha256').update('another build').digest('hex') }));
    const state = read('.research-assistant-loop/state.json');
    write('research/assets/forged.md', matter.stringify('\n## Statement\n\nForged.\n', { type: 'lemma', title: 'Forged', status: 'approved', source: { kind: 'self_proved' }, depends_on: [], uses_definitions: [] }));
    const stop = run(['hook', 'Stop'], JSON.stringify({ cwd: root, session_id: 's' }));
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, '');
    assert.match(read('research/assets/forged.md'), /status: approved/); // a stale engine does not "fix" anything
    assert.equal(read('.research-assistant-loop/state.json'), state);
    assert.match(JSON.parse(run(['hook', 'SessionStart'], JSON.stringify({ cwd: root, session_id: 's' })).stdout).hookSpecificOutput.additionalContext, /Refresh Project Setup/);
    const next = run(['next']);
    assert.equal(next.status, 1);
    assert.match(next.stderr, /differs from the one the Research Assistant extension ships/);
    assert.equal(run(['status']).status, 0);

    // The matching driver acts again, and restores what an old driver reverted while the record survived.
    write('.research-assistant-loop/driver.json', JSON.stringify({ sha256: crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex') }));
    fs.rmSync(path.join(root, 'research/assets/forged.md'));
    write('research/assets/lemma_a.md', approved.replace('status: approved', 'status: draft'));
    write('research/approvals.json', JSON.stringify({ version: 1, records: [] }));
    const restored = run(['restore-approvals']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /Restored approval of 1 node\(s\).*lemma_a/);
    assert.match(read('research/assets/lemma_a.md'), /status: approved/);
    assert.ok(!fs.existsSync(path.join(root, 'research/approvals.json')));
    // Content that changed since approval is not restored.
    write('research/assets/lemma_a.md', approved.replace('status: approved', 'status: draft').replace('A lemma.', 'A different lemma.'));
    assert.match(run(['restore-approvals']).stdout, /No approvals to restore/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
