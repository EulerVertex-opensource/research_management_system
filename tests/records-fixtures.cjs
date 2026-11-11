// Reading the record logs in tests: decisions, handoffs, and ideas with their updates applied.
const path = require('node:path');
const esbuild = require('esbuild');

const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/services/ResearchRecords.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
const records = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(records, records.exports, require);
const { decisionFromRecord, ideaUpdatesOf, overlayIdea } = records.exports;

/** Every record in every log under research/log, oldest first. */
function logRecords(map) {
  return [...map.entries()].filter(([file]) => /^(.*\/)?research\/log\/[^/]+\.jsonl$/.test(file))
    .flatMap(([, text]) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Decision records shaped like a decision file: `data` (its fields) and `content` (its text). */
const decisionDocs = (map) => logRecords(map).filter((record) => record.type === 'decision').map((record) => ({ data: record, content: record.text }));
const decisionData = (map) => decisionDocs(map).map((doc) => doc.data);
const handoffTexts = (map) => logRecords(map).filter((record) => record.type === 'handoff').map((record) => record.markdown);
/** An idea's text as the loop reads it, its updates applied. */
const ideaRaw = (map, id) => overlayIdea(map.get(`research/ideas/${id}.md`), ideaUpdatesOf(logRecords(map).filter((record) => record.type === 'decision').map(decisionFromRecord).filter(Boolean)).get(id));

module.exports = { logRecords, decisionDocs, decisionData, handoffTexts, ideaRaw };
