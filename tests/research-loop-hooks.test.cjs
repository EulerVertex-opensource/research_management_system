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

const { stopDecision, preToolUseDecision, contextTokensFrom, contextResetDecision, compactInstructions, isHandbackPrompt, CONTEXT_RESET_TOKENS } = load('../src/services/ResearchLoopHooks.ts');
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
  assert.equal(decision.counted, true, 'a block counts toward the cap outside an autonomous run');
  assert.equal(stopDecision(running({ autonomy: { startedAt: 'then', spent: 0 } }), { session_id: 's' }, 'x').counted, false);
  active.autopilot.sessions.s = { blocks: 3, lastSignature: '', lastBlockAt: '' };
  assert.equal(stopDecision(active, { session_id: 's' }, 'x').capReached, true);
  active.autopilot.sessions.s = { blocks: 1, lastSignature: stageSignature(active), lastBlockAt: '' };
  assert.equal(stopDecision(active, { session_id: 's', stop_hook_active: true }, 'x').block, false);
  assert.equal(stopDecision(active, { session_id: 's', stop_hook_active: false }, 'x').block, true);
});

test('the chat size comes from the last usage record; a large driver chat starts the next stage fresh', () => {
  const claude = (tokens, extra = {}) => JSON.stringify({ type: 'assistant', ...extra, message: { usage: { input_tokens: 2, cache_read_input_tokens: tokens, cache_creation_input_tokens: 10 } } });
  assert.equal(contextTokensFrom([claude(1000), claude(5000), JSON.stringify({ type: 'user' }), '{broken']), 5012);
  assert.equal(contextTokensFrom([claude(5000), claude(900000, { isSidechain: true })]), 5012, 'a subagent record is not the chat');
  assert.equal(contextTokensFrom([JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 31048, cached_input_tokens: 24320 } } } })]), 31048);
  assert.equal(contextTokensFrom(['{}']), undefined);
  const next = { tool_name: 'Bash', tool_input: { command: 'node .claude/skills/research-loop/scripts/research-loop.cjs next' } };
  assert.match(contextResetDecision(running(), next, CONTEXT_RESET_TOKENS + 1), /fresh chat/);
  assert.equal(contextResetDecision(running(), next, CONTEXT_RESET_TOKENS - 1), undefined);
  assert.equal(contextResetDecision(running(), next, undefined), undefined);
  assert.equal(contextResetDecision(running(), { tool_name: 'Bash', tool_input: { command: 'node .claude/skills/research-loop/scripts/research-loop.cjs report proved --summary x' } }, 900000), undefined, 'only the next stage waits for a fresh chat');
  assert.equal(contextResetDecision(running({ status: 'paused' }), next, 900000), undefined);
  assert.equal(contextResetDecision(running({ autonomy: { startedAt: 'then' } }), next, 900000), undefined, 'nobody opens a fresh chat in an autonomous run');
  assert.equal(isHandbackPrompt('Another Claude session sent a message:\n<agent-message from="a1">'), true);
  assert.equal(isHandbackPrompt('<task-notification>\n<task-id>a1</task-id>'), true);
  assert.equal(isHandbackPrompt('continue the loop'), false);
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
    // Without a loop a new chat only learns how to link what it names to the dashboard.
    assert.match(JSON.parse(hook('SessionStart', {}).stdout).hookSpecificOutput.additionalContext, /^Research Assistant: [\s\S]*\[Title\]\(\.research-assistant-loop\/open\/<id>\.md\)/);
    assert.equal(hook('UserPromptSubmit', {}).stdout, '');
    assert.equal(spawnSync(process.execPath, [cli, 'start', '--provider', 'claude', '--goal', 'Prove', '--project', root, '--iteration-cap', '2'], { encoding: 'utf8' }).status, 0);
    const blocked = (result) => result.status === 0 && result.stdout.trim() !== '' && JSON.parse(result.stdout).decision === 'block';
    // A chat the hooks cannot place is not sent on; the researcher invoking the loop's skill makes it the driver.
    assert.equal(hook('Stop', {}).stdout, '');
    hook('UserPromptSubmit', { prompt: '/research-loop' });
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

test('a teaching chat beside the loop never takes its lock, is never sent on at Stop, and may not drive it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-teach-'));
  try {
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    write('research/project.md', '# Project\n');
    const hook = (event, session, input = {}) => spawnSync(process.execPath, [cli, 'hook', event], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: session, ...input }) });
    const state = () => JSON.parse(fs.readFileSync(path.join(root, '.research-assistant-loop/state.json'), 'utf8'));
    const loop = 'node .claude/skills/research-loop/scripts/research-loop.cjs';
    assert.equal(spawnSync(process.execPath, [cli, 'start', '--provider', 'claude', '--goal', 'Prove', '--project', root], { encoding: 'utf8' }).status, 0);
    hook('UserPromptSubmit', 'driver');
    hook('PreToolUse', 'driver', { tool_name: 'Bash', tool_input: { command: `${loop} next` } });
    assert.equal(state().lock.sessionId, 'driver');
    // The driver has been quiet past the lock's lifetime; a chat that does not drive still does not take the lock.
    const loopState = state();
    loopState.lock.heartbeatAt = '2000-01-01T00:00:00.000Z';
    write('.research-assistant-loop/state.json', JSON.stringify(loopState));
    hook('SessionStart', 'teacher');
    assert.equal(state().lock.sessionId, 'driver');
    // A chat the hooks cannot place yet never takes a free lock either.
    const freed = state(); delete freed.lock; write('.research-assistant-loop/state.json', JSON.stringify(freed));
    hook('SessionStart', 'teacher');
    assert.equal(state().lock, undefined);
    // A teaching chat that holds the lock (taken before the hooks knew it) gives it back.
    const held = state(); held.lock = { sessionId: 'teacher', provider: 'claude', acquiredAt: 'now', heartbeatAt: new Date().toISOString() }; write('.research-assistant-loop/state.json', JSON.stringify(held));
    const context = JSON.parse(hook('UserPromptSubmit', 'teacher', { prompt: '/teach' }).stdout);
    assert.match(context.hookSpecificOutput.additionalContext, /this chat is the teaching chat/);
    assert.equal(state().lock, undefined, 'naming the teach skill gives the lock back');
    assert.equal(hook('Stop', 'teacher').stdout, '', 'the teaching chat is not sent on');
    assert.match(hook('PreToolUse', 'teacher', { tool_name: 'Bash', tool_input: { command: `${loop} next` } }).stdout, /"permissionDecision":"deny"/);
    assert.equal(hook('PreToolUse', 'teacher', { tool_name: 'Bash', tool_input: { command: `${loop} teach list` } }).stdout, '');
    // Both chats are told how to link what they name to the dashboard: a relative link file, since chats drop vscode:// links.
    assert.match(JSON.parse(hook('UserPromptSubmit', 'teacher', { prompt: 'next one' }).stdout).hookSpecificOutput.additionalContext, /\[Title\]\(\.research-assistant-loop\/open\/<id>\.md\)/);
    // The driver comes back, takes the lock again, and is still sent on at Stop.
    const driverContext = JSON.parse(hook('UserPromptSubmit', 'driver', { prompt: 'continue' }).stdout).hookSpecificOutput.additionalContext;
    assert.match(driverContext, /dashboard link[\s\S]*\.research-assistant-loop\/open\/<id>\.md/);
    assert.match(spawnSync(process.execPath, [cli, 'status', '--brief', '--project', root], { encoding: 'utf8' }).stdout, /\.research-assistant-loop\/open\/<id>\.md/);
    assert.equal(state().lock.sessionId, 'driver');
    assert.equal(JSON.parse(hook('Stop', 'driver').stdout).decision, 'block');
    // The driver asking for an explanation in its own chat stays the driver.
    hook('UserPromptSubmit', 'driver', { prompt: '/teach' });
    assert.equal(JSON.parse(hook('Stop', 'driver').stdout).decision, 'block');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a chat that only looks at the loop never inherits a quiet driver\'s lock and is never sent on at Stop', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-onlooker-'));
  try {
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    write('research/project.md', '# Project\n');
    const hook = (event, session, input = {}) => spawnSync(process.execPath, [cli, 'hook', event], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: session, ...input }) });
    const statePath = path.join(root, '.research-assistant-loop/state.json');
    const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const quiet = () => { const s = state(); s.lock.heartbeatAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(statePath, JSON.stringify(s)); };
    const loop = 'node .claude/skills/research-loop/scripts/research-loop.cjs';
    assert.equal(spawnSync(process.execPath, [cli, 'start', '--provider', 'claude', '--goal', 'Prove', '--project', root], { encoding: 'utf8' }).status, 0);
    hook('UserPromptSubmit', 'driver', { prompt: 'go' });
    hook('PreToolUse', 'driver', { tool_name: 'Bash', tool_input: { command: `${loop} next` } });
    assert.equal(state().lock.sessionId, 'driver');
    // The driver waits on a long background subagent: no hook fires in its chat, so its heartbeat goes quiet.
    quiet();
    assert.match(JSON.parse(hook('SessionStart', 'onlooker').stdout).hookSpecificOutput.additionalContext, /another session \(driver\) is driving/);
    hook('UserPromptSubmit', 'onlooker', { prompt: 'why did the loop stop earlier?' });
    hook('PreToolUse', 'onlooker', { tool_name: 'Bash', tool_input: { command: `${loop} status` } });
    assert.equal(state().lock.sessionId, 'driver', 'looking at the loop does not take it over');
    assert.equal(hook('Stop', 'onlooker').stdout, '', 'the onlooker is not sent on to drive');
    // The subagent hands back: the driver still holds the loop and is sent on.
    hook('UserPromptSubmit', 'driver', { prompt: 'Another Claude session sent a message:\n<agent-message from="a1">done</agent-message>' });
    assert.equal(state().lock.sessionId, 'driver');
    assert.equal(JSON.parse(hook('Stop', 'driver').stdout).decision, 'block');
    // A fresh chat where the researcher invokes the loop's skill takes over a quiet lock.
    quiet();
    hook('UserPromptSubmit', 'fresh', { prompt: '/research-loop' });
    assert.equal(state().lock.sessionId, 'fresh');
    assert.equal(JSON.parse(hook('Stop', 'fresh').stdout).decision, 'block');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a chat writing the manuscript never takes the loop\'s lock or is sent on to drive it, even after the loop resumes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-writer-'));
  try {
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    write('research/project.md', '# Project\n');
    const hook = (event, session, input = {}) => spawnSync(process.execPath, [cli, 'hook', event], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: session, ...input }) });
    const statePath = path.join(root, '.research-assistant-loop/state.json');
    const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const free = () => { const s = state(); delete s.lock; fs.writeFileSync(statePath, JSON.stringify(s)); };
    const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' });
    const loop = 'node .claude/skills/research-loop/scripts/research-loop.cjs';
    const manuscript = 'node .claude/skills/draft-latex/scripts/manuscript-writing.cjs';
    assert.equal(run('start', '--provider', 'claude', '--goal', 'Prove').status, 0);
    hook('UserPromptSubmit', 'driver', { prompt: 'go' });
    hook('PreToolUse', 'driver', { tool_name: 'Bash', tool_input: { command: `${loop} next` } });
    assert.equal(state().lock.sessionId, 'driver', 'running next makes a chat the driver and takes the lock');
    // The driver's chat grew large and gave the lock back; the researcher works on the paper meanwhile.
    free();
    const context = JSON.parse(hook('UserPromptSubmit', 'writer', { prompt: 'Use the draft-latex skill to update manuscript section intro. This chat is only for the manuscript; the loop runs in its own chat.' }).stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /this chat writes the manuscript/);
    assert.doesNotMatch(context, /stage draft_project/);
    assert.equal(state().lock, undefined, 'a writing chat never takes the lock');
    assert.equal(hook('Stop', 'writer').stdout, '', 'a writing chat is not sent on to drive the loop');
    assert.match(hook('PreToolUse', 'writer', { tool_name: 'Bash', tool_input: { command: `${loop} next` } }).stdout, /"permissionDecision":"deny"[\s\S]*writes the manuscript/);
    assert.equal(hook('PreToolUse', 'writer', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'sections/intro.tex') } }).stdout, '', 'it edits the TeX');
    assert.equal(hook('PreToolUse', 'writer', { tool_name: 'Bash', tool_input: { command: `${manuscript} lock intro --apply` } }).stdout, '');
    assert.match(hook('PreToolUse', 'writer', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'research/assets/a.md'), content: '---\nstatus: approved\n---\n' } }).stdout, /"permissionDecision":"deny"/, 'the usual guards still hold');
    // Paused while the paper is written, then resumed from the dashboard: the writer still is not sent on.
    run('pause');
    free();
    hook('UserPromptSubmit', 'writer2', { prompt: '/plan-manuscript' });
    assert.equal(state().lock, undefined);
    run('resume');
    assert.equal(hook('Stop', 'writer2').stdout, '');
    assert.equal(state().lock, undefined);
    hook('UserPromptSubmit', 'driver', { prompt: 'continue' });
    assert.equal(state().lock.sessionId, 'driver', 'the loop\'s own chat takes the loop back');
    assert.equal(JSON.parse(hook('Stop', 'driver').stdout).decision, 'block');
    // A chat the hooks cannot place, with the lock free, is told about the loop but neither takes it nor is sent on.
    free();
    assert.match(JSON.parse(hook('UserPromptSubmit', 'other', { prompt: 'what does section 2 say?' }).stdout).hookSpecificOutput.additionalContext, /no chat is driving it right now/);
    assert.equal(state().lock, undefined);
    assert.equal(hook('Stop', 'other').stdout, '');
    // The dashboard's continue prompt asks a fresh chat to drive.
    hook('UserPromptSubmit', 'fresh', { prompt: 'Continue the research loop: run research-loop next and follow it.' });
    assert.equal(state().lock.sessionId, 'fresh');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a large driver chat pauses the loop before next and frees the lock; hand-backs get a compact status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-context-'));
  try {
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    write('research/project.md', '# Project\n');
    const transcript = (tokens) => { const file = path.join(root, `t-${tokens}.jsonl`); fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } }) + '\n'); return file; };
    const hook = (event, input = {}) => spawnSync(process.execPath, [cli, 'hook', event], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: 'driver', ...input }) });
    const state = () => JSON.parse(fs.readFileSync(path.join(root, '.research-assistant-loop/state.json'), 'utf8'));
    const next = { tool_name: 'Bash', tool_input: { command: 'node .claude/skills/research-loop/scripts/research-loop.cjs next' } };
    assert.equal(spawnSync(process.execPath, [cli, 'start', '--provider', 'claude', '--goal', 'Prove', '--project', root], { encoding: 'utf8' }).status, 0);
    const full = JSON.parse(hook('UserPromptSubmit', { prompt: '/research-loop' }).stdout).hookSpecificOutput.additionalContext;
    assert.match(full, /dashboard link/);
    const compact = JSON.parse(hook('UserPromptSubmit', { prompt: 'Another Claude session sent a message:\n<agent-message from="a1">done</agent-message>' }).stdout).hookSpecificOutput.additionalContext;
    assert.match(compact, /^Research loop: running/);
    assert.doesNotMatch(compact, /dashboard link|Continue with/);
    assert.equal(state().lock.sessionId, 'driver');
    assert.equal(hook('PreToolUse', { ...next, transcript_path: transcript(50000) }).stdout, '', 'a small chat goes on');
    const denied = hook('PreToolUse', { ...next, transcript_path: transcript(CONTEXT_RESET_TOKENS + 5000) });
    assert.match(denied.stdout, /"permissionDecision":"deny"/);
    assert.match(denied.stdout, /\/clear/);
    assert.equal(state().status, 'paused');
    assert.equal(state().lock, undefined, 'a fresh chat may resume without taking over');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the driver\'s compaction summary keeps what no file records; nothing without a loop', () => {
  const text = compactInstructions(running());
  assert.match(text, /stage plan, asset main_theorem/);
  assert.match(text, /research-loop\.cjs next/);
  assert.match(text, /researcher said in this chat that no file records/);
  assert.match(text, /Leave out: proof text/);
  assert.doesNotMatch(text, /autonomous/);
  assert.match(compactInstructions(running({ autonomy: { startedAt: 'then', spent: 0 } })), /no one is watching: continue without asking/);
  assert.match(compactInstructions(running({ status: 'paused' })), /\(paused, stage plan/);
  assert.equal(compactInstructions(undefined), undefined);
  assert.equal(compactInstructions(running({ status: 'stopped' })), undefined);
});

test('the driver\'s chat size is logged at every next, and its compactions with their instructions; other chats are not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-measure-'));
  try {
    const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
    write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
    write('research/project.md', '# Project\n');
    const transcript = (tokens) => { const file = path.join(root, `t-${tokens}.jsonl`); fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } }) + '\n'); return file; };
    const hook = (event, session, input = {}) => spawnSync(process.execPath, [cli, 'hook', event], { encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: session, ...input }) });
    const events = (type) => fs.readFileSync(path.join(root, '.research-assistant-loop/events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.type === type);
    const next = { tool_name: 'Bash', tool_input: { command: 'node .claude/skills/research-loop/scripts/research-loop.cjs next' } };
    assert.equal(spawnSync(process.execPath, [cli, 'start', '--provider', 'claude', '--goal', 'Prove', '--project', root], { encoding: 'utf8' }).status, 0);
    hook('UserPromptSubmit', 'driver', { prompt: '/research-loop' });
    hook('PreToolUse', 'driver', { ...next, transcript_path: transcript(40000) });
    hook('PreToolUse', 'driver', { tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: transcript(41000) });
    hook('PreToolUse', 'driver', { ...next, transcript_path: transcript(90000) });
    hook('PreToolUse', 'other', { tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: transcript(70000) });
    assert.deepEqual(events('context_size').map((event) => [event.sessionId, event.tokens, event.autonomous]), [['driver', 40001, false], ['driver', 90001, false]], 'only the driver\'s next is measured');

    const compacted = hook('PreCompact', 'driver', { trigger: 'auto', transcript_path: transcript(150000) });
    assert.equal(compacted.status, 0);
    assert.match(compacted.stdout, /^Research loop: this chat drives the research loop/);
    assert.match(compacted.stdout, /Leave out: proof text/);
    assert.deepEqual(events('context_compacted').map((event) => [event.sessionId, event.trigger, event.tokens]), [['driver', 'auto', 150001]]);
    assert.equal(hook('PreCompact', 'other', { trigger: 'manual', transcript_path: transcript(150000) }).stdout, '', 'another chat compacts as it likes');
    assert.equal(events('context_compacted').length, 1);
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
