const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const server = path.resolve(__dirname, '../out/research-loop-mcp.cjs');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-mcp-'));
  const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
  write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared', latex: { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' }, research: { root: 'research', project: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' } }));
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function client(root) {
  const child = spawn(process.execPath, [server, '--project', root], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RESEARCH_LOOP_MCP_CALL_TIMEOUT_MS: '1500' } });
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).result.content[0].text);
  return { request, call, close: () => child.stdin.end() };
}

test('MCP bridge lists tools and degrades gracefully without the extension', async () => {
  const p = project();
  const c = client(p.root);
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    const tools = (await c.request('tools/list', {})).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools, ['ask_researcher', 'request_approval', 'await_answer', 'record_idea', 'loop_status']);
    assert.deepEqual(await c.call('ask_researcher', { question: 'Goal?', kind: 'goals' }), { answered: false, reason: 'extension not running' });
    const idea = await c.call('record_idea', { title: 'Hunch', body: 'Try compactness.' });
    assert.equal(idea.ok, true);
    assert.match(fs.readFileSync(path.join(p.root, idea.path), 'utf8'), /origin: agent/);
    assert.equal((await c.call('loop_status', {})).state.status, 'idle');
    const unknown = await c.request('nope', {});
    assert.equal(unknown.error.code, -32601);
  } finally { c.close(); p.cleanup(); }
});

test('MCP bridge forwards pending, await_answer, and final results with the bridge token; hung extensions time out', async () => {
  const p = project();
  const requests = [];
  const bridge = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ auth: request.headers.authorization, body: JSON.parse(body) });
      if (request.headers.authorization !== 'Bearer secret') { response.writeHead(401); response.end(); return; }
      const { name, arguments: args } = JSON.parse(body);
      if (args.hang) return; // never answer -> client timeout
      response.setHeader('content-type', 'application/json');
      if (name === 'ask_researcher') response.end(JSON.stringify({ status: 'pending', answered: false, id: 'q1' }));
      else response.end(JSON.stringify({ status: 'final', answered: true, id: args.id ?? 'r1', decision: 'answer', text: `answer to ${name}` }));
    });
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const port = bridge.address().port;
  const c = client(p.root);
  try {
    p.write('.research-assistant-loop/bridge.json', JSON.stringify({ port, token: 'wrong' }));
    assert.deepEqual(await c.call('ask_researcher', { question: 'Q', kind: 'discussion' }), { answered: false, reason: 'unauthorized' });
    p.write('.research-assistant-loop/bridge.json', JSON.stringify({ port, token: 'secret' }));
    const pending = await c.call('ask_researcher', { question: 'Q', kind: 'discussion' });
    assert.equal(pending.status, 'pending');
    const final = await c.call('await_answer', { id: pending.id });
    assert.deepEqual([final.status, final.id, final.text], ['final', 'q1', 'answer to await_answer']);
    const approval = await c.call('request_approval', { kind: 'asset', target: 'main_theorem', summary: 'proof' });
    assert.equal(approval.text, 'answer to request_approval');
    assert.equal(requests.at(-1).body.arguments.target, 'main_theorem');
    const timeout = await c.call('ask_researcher', { question: 'Q', kind: 'discussion', hang: true });
    assert.equal(timeout.reason, 'timeout');
  } finally { c.close(); bridge.close(); p.cleanup(); }
});
