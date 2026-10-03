const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const { parse } = require('jsonc-parser');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { buildHooksFile, buildProjectMcpJson, upsertCodexMcpTable } = load('../src/services/AgentIntegrationCore.ts');
const { AGENT_PROVIDERS, PROVIDER_IDS, loopScriptPath, chatHint, invocation } = load('../src/services/AgentProviders.ts');
const { GENERATED_START, GENERATED_END, claudeMdForAgentsMd, upsertGeneratedSection } = load('../src/domain/agentInstructions.ts');

test('registry covers both agents and derives paths and hints from one table', () => {
  assert.deepEqual(PROVIDER_IDS, ['claude', 'codex']);
  assert.equal(loopScriptPath('/repo', 'claude'), '/repo/.claude/skills/research-loop/scripts/research-loop.cjs');
  assert.equal(loopScriptPath('/repo', 'codex', 'research-loop-mcp.cjs'), '/repo/.agents/skills/research-loop/scripts/research-loop-mcp.cjs');
  assert.equal(invocation('codex'), '$research-loop');
  assert.equal(chatHint('claude'), 'Type /research-loop in the Claude Code chat.');
});

for (const id of ['claude', 'codex']) {
  test(`${id} hooks file preserves user hooks, is idempotent, and uses the registry matcher`, () => {
    const spec = AGENT_PROVIDERS[id];
    const script = loopScriptPath('/repo', id);
    const existing = `{
  // keep me
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "echo mine" }] }, { "hooks": [{ "type": "command", "command": "node \\"/old/research-loop.cjs\\" hook Stop" }] }]
  }
}
`;
    const once = buildHooksFile(id, existing, script);
    assert.match(once, /keep me/);
    const parsed = parse(once);
    assert.equal(parsed.hooks.Stop.length, 2);
    assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'echo mine');
    assert.ok(parsed.hooks.Stop[1].hooks[0].command.includes(script));
    assert.equal(parsed.hooks.PreToolUse[0].matcher, spec.writeToolMatcher);
    assert.equal(parsed.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
    assert.equal(Boolean(parsed.permissions), spec.hooksFileHasPermissions);
    if (spec.hooksFileHasPermissions) assert.ok(parsed.permissions.allow.includes('mcp__research-assistant'));
    assert.equal(buildHooksFile(id, once, script), once);
    assert.throws(() => buildHooksFile(id, '[1]', script), /JSON object/);
  });
}

test('project MCP JSON keeps other servers', () => {
  const mcp = parse(buildProjectMcpJson('{"mcpServers":{"other":{"command":"x"}}}', '/repo/mcp.cjs', '/repo'));
  assert.equal(mcp.mcpServers.other.command, 'x');
  assert.deepEqual(mcp.mcpServers['research-assistant'].args, ['/repo/mcp.cjs', '--project', '/repo']);
});

test('Codex MCP table is owned as a whole and everything else is untouched', () => {
  const user = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
  const once = upsertCodexMcpTable(user, '/ext/out/research-loop-mcp.cjs');
  assert.ok(once.startsWith(user.trimEnd()));
  assert.match(once, /\[mcp_servers\.research-assistant\]\ncommand = "node"\nargs = \["\/ext\/out\/research-loop-mcp\.cjs"\]\ndefault_tools_approval_mode = "approve"\n$/);
  assert.equal(upsertCodexMcpTable(once, '/ext/out/research-loop-mcp.cjs'), once);
  const legacy = '[mcp_servers.research-assistant]\ncommand = "node"\nargs = ["/old.cjs"]\n\n[mcp_servers.research-assistant.env]\nA = "1"\n\n[mcp_servers.after]\ncommand = "y"\n';
  const moved = upsertCodexMcpTable(legacy, '/new.cjs');
  assert.doesNotMatch(moved, /old\.cjs|A = "1"/);
  assert.match(moved, /default_tools_approval_mode = "approve"\n\n\[mcp_servers\.after\]\ncommand = "y"\n$/);
  assert.equal(upsertCodexMcpTable('', '/a.cjs').split('\n')[0], '[mcp_servers.research-assistant]');
});

test('CLAUDE.md gives way to AGENTS.md: the old generated copy is dropped, own text keeps an @AGENTS.md import', () => {
  const generated = upsertGeneratedSection('', '# Mathematical Research Workspace\n\n- invariant');
  assert.equal(claudeMdForAgentsMd(generated), null);
  assert.equal(claudeMdForAgentsMd('  \n'), null);

  const own = `# My notes\n\nPrefer short proofs.\n\n${generated}`;
  const migrated = claudeMdForAgentsMd(own);
  assert.equal(migrated, `# My notes\n\nPrefer short proofs.\n\n${GENERATED_START}\n@AGENTS.md\n${GENERATED_END}\n`);
  assert.equal(claudeMdForAgentsMd(migrated), migrated, 'idempotent');
  assert.equal(claudeMdForAgentsMd(`${GENERATED_START}\n@AGENTS.md\n${GENERATED_END}\n`), null);

  const unmarked = '# My notes\n';
  assert.equal(claudeMdForAgentsMd(unmarked), `# My notes\n\n${GENERATED_START}\n@AGENTS.md\n${GENERATED_END}\n`);
  const importsItself = '@AGENTS.md\n\n## Claude Code\nUse plan mode.\n';
  assert.equal(claudeMdForAgentsMd(importsItself), importsItself);
  assert.equal(claudeMdForAgentsMd(`${importsItself}\n${generated}`), importsItself);
});
