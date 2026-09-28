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

const { mergeClaudeSettings, buildClaudeMcpJson, buildCodexHooksJson, mergeCodexConfigToml } = load('../src/services/AgentIntegrationCore.ts');
const script = '/repo/.claude/skills/research-loop/scripts/research-loop.cjs';

test('Claude settings merge preserves user hooks and comments and is idempotent', () => {
  const existing = `{
  // keep me
  "permissions": { "allow": ["Bash(npm test)"], },
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "echo mine" }] }, { "hooks": [{ "type": "command", "command": "node \\"/old/research-loop.cjs\\" hook Stop" }] }]
  }
}
`;
  const once = mergeClaudeSettings(existing, script);
  assert.match(once, /keep me/);
  const parsed = parse(once);
  assert.deepEqual(parsed.permissions.allow.slice(0, 1), ['Bash(npm test)']);
  assert.ok(parsed.permissions.allow.includes('mcp__research-assistant'));
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.match(parsed.hooks.Stop.at(-1).hooks[0].command, /\/repo\/.claude/);
  assert.ok(parsed.hooks.PreToolUse[0].matcher.includes('Write'));
  assert.equal(mergeClaudeSettings(once, script), once);
  assert.equal(parse(mergeClaudeSettings('', script)).hooks.SessionStart.length, 1);
  assert.throws(() => mergeClaudeSettings('[1]', script), /JSON object/);
});

test('MCP and Codex builders', () => {
  const mcp = parse(buildClaudeMcpJson('{"mcpServers":{"other":{"command":"x"}}}', '/repo/mcp.cjs', '/repo'));
  assert.equal(mcp.mcpServers.other.command, 'x');
  assert.deepEqual(mcp.mcpServers['research-assistant'].args, ['/repo/mcp.cjs', '--project', '/repo']);
  const codex = parse(buildCodexHooksJson('', '/repo/.agents/skills/research-loop/scripts/research-loop.cjs'));
  assert.match(codex.hooks.PreToolUse[0].matcher, /apply_patch/);
  const toml = mergeCodexConfigToml('model = "o3"\n', '/repo/mcp.cjs', '/repo');
  assert.match(toml.content, /^model = "o3"\n\n# research-assistant:start\n\[mcp_servers\.research-assistant\]/);
  assert.equal(mergeCodexConfigToml(toml.content, '/repo/mcp.cjs', '/repo').content, toml.content);
  const moved = mergeCodexConfigToml(toml.content, '/new/mcp.cjs', '/new').content;
  assert.match(moved, /\/new\/mcp\.cjs/);
  assert.doesNotMatch(moved, /\/repo\/mcp\.cjs/);
  const conflict = mergeCodexConfigToml('[mcp_servers.research-assistant]\ncommand = "custom"\n', '/repo/mcp.cjs', '/repo');
  assert.match(conflict.skipped, /already defines/);
  assert.equal(conflict.content, '[mcp_servers.research-assistant]\ncommand = "custom"\n');
});
