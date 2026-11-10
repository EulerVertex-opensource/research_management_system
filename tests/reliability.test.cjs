// Regressions from the 0.0.4 engineering review (F04, F07, F08, F09, F10): state and context bookkeeping
// that must stay correct when the log grows, a write fails halfway, or a file cannot be read.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const { pathsFromConfigText } = load('../src/services/ProjectPathsCore.ts');

const paths = pathsFromConfigText('{}');
const STATE = '.research-assistant-loop/state.json';
const SETTINGS = '.research-assistant-loop/settings.json';
const node = (type, title, statement, extra = {}) => matter.stringify(`\n## Statement\n\n${statement}\n`, { type, title, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    appendFile: async (file, content) => { map.set(file, (map.get(file) ?? '') + content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
    deleteFile: async (file) => { map.delete(file); },
  };
}

let counter = 0;
function fixture(initial = {}) {
  const files = memoryFiles({ [paths.projectMd]: '# Project\n\n## Required Results\n', [paths.paperIndex]: '# Papers\n', [SETTINGS]: JSON.stringify({ version: 1 }), ...initial });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 5 });
  return { files, core, map: files.map };
}

test('F04: earlier stage reports reach the context however many reads were logged after them', async () => {
  const f = fixture();
  await f.core.start('claude', { goal: 'Prove it.' });
  await f.core.event('report', { stage: 'execute', outcome: 'failed', assetId: 'main_theorem', summary: 'The route needs a uniform bound.' });
  for (let i = 0; i < 500; i++) await f.core.event('context_request', { id: `n${i}` });
  const sources = await f.core.contextSources();
  assert.deepEqual(sources.reports.map((report) => report.summary), ['The route needs a uniform bound.']);
});

test('F07: a stage change that fails while logging leaves state.json at the old stage, so a retry is safe', async () => {
  const f = fixture();
  await f.core.start('claude', { goal: 'Prove it.' });
  const before = JSON.parse(f.map.get(STATE)).stage;
  assert.notEqual(before, 'waiting');
  f.files.appendFile = async () => { throw new Error('EBUSY: events.jsonl is locked'); };
  await assert.rejects(f.core.setStage('waiting'), /EBUSY/);
  assert.equal(JSON.parse(f.map.get(STATE)).stage, before);
});

test('F08: an unreadable or newer state is an error, never "no loop" that a start would overwrite', async () => {
  const broken = fixture({ [STATE]: '{"version": 2, "stage": "exe' });
  await assert.rejects(broken.core.load(), /not valid JSON.*nothing was overwritten/);
  await assert.rejects(broken.core.peek(), /not valid JSON/);
  const newer = fixture({ [STATE]: JSON.stringify({ version: 999, stage: 'select' }) });
  await assert.rejects(newer.core.load(), /newer Research Assistant \(state version 999\)/);
  assert.equal(newer.map.get(STATE), JSON.stringify({ version: 999, stage: 'select' }));
  // An empty file and an old version still read as no loop, as before.
  assert.equal(await fixture({ [STATE]: '' }).core.peek(), undefined);
  assert.equal(await fixture({ [STATE]: JSON.stringify({ version: 1 }) }).core.peek(), undefined);
});

test('F09: the loop stops, naming the file, while a node does not parse, instead of treating it as missing', async () => {
  const f = fixture();
  await f.core.start('claude', { goal: 'Prove it.' });
  const stage = f.core.current.stage;
  f.map.set(`${paths.assets}/lemma_bound.md`, '---\ntype: lemma\ntitle: Lemma: uniform bound\nstatus: draft\n---\n\n## Statement\n\nA bound.\n');
  const result = await f.core.next();
  assert.match(result.blocked, /do not parse/);
  assert.match(result.blocked, /research\/assets\/lemma_bound\.md/);
  assert.equal(f.core.current.stage, stage);
  f.map.set(`${paths.assets}/lemma_bound.md`, node('lemma', 'Lemma: uniform bound', 'A bound.'));
  assert.doesNotMatch((await f.core.next()).blocked ?? '', /do not parse/);
});

test('F10: a file deleted during a stage is reported and fails the stage, except ideas', async () => {
  const f = fixture({
    [`${paths.definitions}/natural.md`]: matter.stringify('\nA natural number is a member of N.\n', { type: 'definition', title: 'Definition (natural)', status: 'draft', depends_on: [] }),
    [`${paths.ideas}/try_induction.md`]: matter.stringify('\nTry induction.\n', { type: 'idea', title: 'Try induction', status: 'draft', tags: [] }),
  });
  await f.core.start('claude', { goal: 'Prove it.' });
  await f.core.takeSnapshot();
  f.map.delete(`${paths.definitions}/natural.md`);
  f.map.delete(`${paths.ideas}/try_induction.md`);
  const { removed } = await f.core.changedFiles();
  assert.deepEqual(removed, [`${paths.definitions}/natural.md`, `${paths.ideas}/try_induction.md`]);
  const { problems } = await f.core.validateStageFiles();
  assert.ok(problems.some((problem) => problem.startsWith(`${paths.definitions}/natural.md: deleted during stage`)), problems.join('\n'));
  assert.ok(!problems.some((problem) => problem.includes('try_induction')), problems.join('\n'));
});

test('F12: saving the same idea again moments later returns the first save; a different idea, or the same one later, is new', async () => {
  let clock = Date.parse('2026-11-09T10:00:00Z');
  const files = memoryFiles({ [paths.projectMd]: '# Project\n', [SETTINGS]: JSON.stringify({ version: 1 }) });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, now: () => new Date(clock).toISOString() });
  const first = await core.saveIdea('Try induction', 'Induct on n.', [], 'agent', ['route'], 'approach');
  clock += 30_000;
  assert.equal(await core.saveIdea('Try induction', 'Induct on n.', [], 'agent', ['route'], 'approach'), first, 'a retried call');
  const ideas = () => [...files.map.keys()].filter((file) => file.startsWith(`${paths.ideas}/`));
  assert.equal(ideas().length, 1);
  assert.notEqual(await core.saveIdea('Try induction', 'Induct on n, strongly.', [], 'agent', ['route'], 'approach'), first);
  assert.notEqual(await core.saveIdea('Try induction', 'Induct on n.', [], 'researcher', ['route'], 'approach'), first, 'whose idea it is matters');
  clock += 11 * 60_000;
  assert.notEqual(await core.saveIdea('Try induction', 'Induct on n.', [], 'agent', ['route'], 'approach'), first, 'the same idea much later is deliberate');
  assert.equal(ideas().length, 4);
});
