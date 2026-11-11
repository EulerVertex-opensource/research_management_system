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
const { collectGraphPayload } = load('../src/services/GraphViewModel.ts');
const { wordDiff } = load('../webview-src/graph/ProofDiff.tsx');
const { repairPayload, repairGraph } = load('../webview-src/graph/graphModel.ts');

const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', library: 'research/library', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const SETTINGS = '.research-assistant-loop/settings.json';
const MAIN = 'research/assets/main_theorem.md';
const LEMMA = 'research/assets/key_lemma.md';
const NATURAL = 'research/definitions/natural.md';
const PROOF = 'By the key lemma, n = n for every natural number n.';
const REPAIRED = 'By the key lemma, n = n for every natural number n, including n = 0, which the key lemma covers since 0 is natural.';
const asset = (title, type, proof, extra = {}) => matter.stringify(`\n## Statement\n\n${title} holds for every natural number n.\n${proof ? `\n## Proof\n\n${proof}\n` : ''}`, { type, title, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: ['natural'], tags: [], ...extra });
const definition = () => matter.stringify('\nA natural number is a member of N.\n', { type: 'definition', title: 'Definition (natural)', status: 'draft', depends_on: [] });
const settings = (rigor = {}) => JSON.stringify({ version: 1, rigor: { refuteSearch: 'off', agreeDefinitions: 'off', ...rigor } });
const projectMd = (required) => `---\ntype: project\nschema_version: 2\nrequired_results:\n${required.map((id) => `  - id: ${id}\n    role: main result`).join('\n')}\n---\n\n# Project\n\n## Main Problem\n\nComplete the researcher's results.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFill the gap in the main theorem.\n\n## Background\n\nNone.\n`;

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
/** The researcher's upload, extracted: a main theorem with a proof, the key lemma it rests on without one, and a definition. */
function fixture(rigor = {}) {
  const files = memoryFiles({
    'research/project.md': '# Project\n', 'research/papers.md': '# Papers\n', [SETTINGS]: settings(rigor),
    [MAIN]: asset('Main theorem', 'theorem', PROOF, { depends_on: ['key_lemma'] }),
    [LEMMA]: asset('Key lemma', 'lemma', ''),
    [NATURAL]: definition(),
  });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 50 });
  return { files, core, map: files.map };
}
const decisions = (f, kind) => [...f.map.entries()].filter(([file]) => file.startsWith('research/decisions/')).map(([, raw]) => matter(raw)).filter((item) => !kind || item.data.kind === kind);
const proofOf = (f, file) => (matter(f.map.get(file)).content.split('## Proof')[1] ?? '').trim();
const plan = (target, title, steps = '1. [ ] Cover n = 0.') => matter.stringify(`\n## Goal\n\nTarget: [${target}](../assets/${target}.md)\n\n## Plan\n\n${steps}\n\n## Verification\n\nCheck n = 0.\n\n## Assumed definitions\n\n- natural\n`, { type: 'plan', title, status: 'pending', target_asset: target, inspired_by: [], tags: [] });


/** Check the upload the way the extracting chat does, take it in, approve the goals, and prove the key lemma; returns at the main theorem's stage. */
async function intakeToMain(f, { check = true } = {}) {
  if (check) {
    await f.core.recordExtractionCheck('natural', 'confirmed', 'Well formed.');
    await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 uses the key lemma at n = 0, which it does not cover as stated.');
  }
  await f.core.intake(['main_theorem', 'key_lemma', 'natural'], { provider: 'claude', source: 'main.tex' });
  assert.equal((await f.core.next()).stage, 'draft_project');
  f.map.set('research/project.md', projectMd(['main_theorem']));
  await f.core.report({ outcome: 'complete', summary: 'Goals: the main theorem. Gap: step 1.' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.kind === 'project').id, 'approved', '', 'test');
  assert.equal((await f.core.next()).current?.assetId ?? f.core.current.current.assetId, 'key_lemma');
  f.map.set('research/plans/key_lemma_plan.md', plan('key_lemma', 'Prove the key lemma', '1. [x] Induction on n.'));
  await f.core.report({ outcome: 'complete', summary: 'Plan', planId: 'key_lemma_plan' });
  f.map.set(LEMMA, asset('Key lemma', 'lemma', 'Induction on n.'));
  setPlan(f, 'key_lemma_plan', { status: 'succeeded' }, '## Outcome\n\nProved by induction.');
  await f.core.report({ outcome: 'proved', summary: 'Proved the key lemma.' });
  setPlan(f, 'key_lemma_plan', {}, '## Verdict\n\nconfirmed: every step follows.');
  await f.core.report({ outcome: 'confirmed', summary: 'Sound.' });
  return f.core.next();
}
function setPlan(f, id, data, append = '') {
  const file = `research/plans/${id}.md`;
  const parsed = matter(f.map.get(file));
  f.map.set(file, matter.stringify(`${parsed.content.trimEnd()}\n\n${append}\n`, { ...parsed.data, ...data }));
}
const planData = (f, id) => matter(f.map.get(`research/plans/${id}.md`));

test('the intake report names the main results, the gaps, and what has no proof yet', async () => {
  const f = fixture();
  await f.core.recordExtractionCheck('natural', 'confirmed', 'Well formed.');
  await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 uses the key lemma at n = 0.');
  const report = await f.core.intakeReport(['main_theorem', 'key_lemma', 'natural']);
  assert.deepEqual(report.main, ['main_theorem'], 'the key lemma serves the main theorem');
  assert.deepEqual(report.gaps.map((item) => [item.id, item.summary]), [['main_theorem', 'Step 1 uses the key lemma at n = 0.']]);
  assert.deepEqual(report.unproved.map((item) => item.id), ['key_lemma']);
  assert.deepEqual(report.confirmed.map((item) => item.id), ['natural']);
});

test('checks the researcher asked for run whatever the setting says', async () => {
  const f = fixture({ verifyExtracted: 'off' });
  assert.equal((await f.core.extractionChecks(['main_theorem'])).enabled, false);
  const asked = await f.core.extractionChecks(['main_theorem'], { requested: true });
  assert.equal(asked.enabled, true);
  assert.deepEqual(asked.pending, [{ id: 'main_theorem', mode: 'proof' }]);
});

test('an intake drafts the goals from the researcher\'s main results and records their consent to repair', async () => {
  const f = fixture();
  await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 uses the key lemma at n = 0.');
  f.map.set('research/project.md', projectMd(['something_else']));
  await f.core.intake(['main_theorem', 'key_lemma', 'natural'], { provider: 'claude', source: 'main.tex' });
  const next = await f.core.next();
  assert.equal(next.stage, 'draft_project', 'drafted from the intake even though project.md already looks complete');
  assert.match(next.instruction, /researcher's own results/);
  assert.match(next.instruction, /Main theorem \(main_theorem\)/);
  assert.match(next.instruction, /Step 1 uses the key lemma at n = 0/);
  assert.match(next.instruction, /Without a proof yet: Key lemma \(key_lemma\)/);
  assert.deepEqual(decisions(f, 'repair_request').map((item) => item.data.target), ['main_theorem'], 'only results with a proof of their own');
  assert.deepEqual(f.core.current.intake.main, ['main_theorem']);
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Goals.' }), /main_theorem under required_results/);
  f.map.set('research/project.md', projectMd(['main_theorem']));
  assert.equal((await f.core.report({ outcome: 'complete', summary: 'Goals: the main theorem.' })).stage, 'review_project');
});

test('a gap in the researcher\'s proof is repaired: the plan keeps their proof, the repaired one replaces it, and the approval says so', async () => {
  const f = fixture();
  const next = await intakeToMain(f);
  assert.equal(next.stage, 'plan');
  assert.equal(f.core.current.current.assetId, 'main_theorem');
  assert.match(next.instruction, /a repair of the researcher's own proof/);
  assert.match(next.instruction, /Step 1 uses the key lemma at n = 0/);
  f.map.set('research/plans/main_repair.md', plan('main_theorem', 'Repair step 1'));
  const planned = await f.core.report({ outcome: 'complete', summary: 'Repair plan', planId: 'main_repair' });
  assert.equal(planned.stage, 'execute');
  const stamped = planData(f, 'main_repair');
  assert.equal(stamped.data.purpose, 'repair');
  assert.match(stamped.content, /## Gap\n\nStep 1 uses the key lemma at n = 0/);
  assert.match(stamped.content, new RegExp(`## Previous proof\\n\\n${PROOF}`));
  assert.match((await f.core.next()).instruction, /replace ## Proof in the asset with the complete repaired proof/);
  setPlan(f, 'main_repair', { status: 'succeeded' }, '## Outcome\n\nCovered n = 0.');
  await assert.rejects(f.core.report({ outcome: 'proved', summary: 'Repaired.' }), /proof of main_theorem is unchanged/);
  f.map.set(MAIN, asset('Main theorem', 'theorem', REPAIRED, { depends_on: ['key_lemma'] }));
  assert.equal((await f.core.report({ outcome: 'proved', summary: 'Repaired step 1.' })).stage, 'verify_proof');
  setPlan(f, 'main_repair', {}, '## Verdict\n\nconfirmed: n = 0 is now covered.');
  await f.core.report({ outcome: 'confirmed', summary: 'Sound.' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'asset' && item.target === 'main_theorem');
  assert.match(request.reason, /Your proof, repaired by main_repair/);
  assert.equal(proofOf(f, MAIN), REPAIRED);
  const after = await f.core.next();
  assert.notEqual(after.stage, 'plan', 'a verified repair is not repaired again');
});

test('a rejected repair brings the researcher\'s proof back and counts as a failed attempt; the next plan is a repair again', async () => {
  const f = fixture();
  await intakeToMain(f);
  f.map.set('research/plans/main_repair.md', plan('main_theorem', 'Repair step 1'));
  await f.core.report({ outcome: 'complete', summary: 'Repair plan', planId: 'main_repair' });
  f.map.set(MAIN, asset('Main theorem', 'theorem', 'A wrong repair.', { depends_on: ['key_lemma'] }));
  setPlan(f, 'main_repair', { status: 'succeeded' }, '## Outcome\n\nCovered n = 0.');
  await f.core.report({ outcome: 'proved', summary: 'Repaired step 1.' });
  setPlan(f, 'main_repair', {}, '## Verdict\n\nrejected: the new step divides by n.');
  await f.core.report({ outcome: 'rejected', summary: 'Divides by n.' });
  assert.equal(proofOf(f, MAIN), PROOF, 'the researcher\'s proof is back');
  assert.equal(planData(f, 'main_repair').data.status, 'failed');
  const next = await f.core.next();
  assert.equal(next.stage, 'plan');
  assert.match(next.instruction, /a repair of the researcher's own proof/);
});

test('a failed repair leaves the researcher\'s proof as written, even after a partial edit', async () => {
  const f = fixture();
  await intakeToMain(f);
  f.map.set('research/plans/main_repair.md', plan('main_theorem', 'Repair step 1'));
  await f.core.report({ outcome: 'complete', summary: 'Repair plan', planId: 'main_repair' });
  f.map.set(MAIN, asset('Main theorem', 'theorem', 'Half an edit.', { depends_on: ['key_lemma'] }));
  setPlan(f, 'main_repair', { status: 'failed' }, '## Failure\n\nn = 0 needs a stronger lemma.');
  await f.core.report({ outcome: 'failed', summary: 'Needs a stronger lemma.' });
  assert.equal(proofOf(f, MAIN), PROOF);
});

test('an intake without earlier checks checks each proof as written first; a confirmed one goes to approval unrepaired', async () => {
  const f = fixture();
  const next = await intakeToMain(f, { check: false });
  assert.equal(next.stage, 'verify_node');
  assert.deepEqual(f.core.current.current.node, { id: 'main_theorem', mode: 'proof' });
  assert.equal((await f.core.next()).stage, 'verify_node', 'the check stays the stage until it is reported');
  await f.core.report({ outcome: 'confirmed', summary: 'Every step follows.' });
  const after = await f.core.next();
  assert.notEqual(after.stage, 'plan');
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'asset' && item.target === 'main_theorem'));
  assert.equal(proofOf(f, MAIN), PROOF);
});

test('without the researcher\'s consent a rejected proof waits for them and is never repaired', async () => {
  const f = fixture();
  await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 uses the key lemma at n = 0.');
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set('research/project.md', projectMd(['main_theorem']));
  await f.core.report({ outcome: 'complete', summary: 'Goals.' });
  await f.core.resolveApproval(f.core.current.approvalQueue.find((item) => item.kind === 'project').id, 'approved', '', 'test');
  await f.core.next();
  assert.ok(!(await f.core.next()).instruction.includes('a repair'));
  await assert.rejects(f.core.requestRepair(['natural']), /Nothing to repair: natural/);
  assert.match(await f.core.requestRepair(['main_theorem']), /check main_theorem as written/);
  assert.equal(decisions(f, 'repair_request').length, 1);
});

// ---------- the dashboard: where each result stands, and the way on to a new goal ----------

function researchNodes(f) {
  return [...f.map.keys()].filter((file) => /^research\/(assets|definitions|ideas|plans)\/.*\.md$/.test(file)).map((file) => {
    const { data, content } = matter(f.map.get(file));
    return { id: path.posix.basename(file, '.md'), filePath: file, body: content, tags: [], depends_on: [], uses_definitions: [], related_assets: [], ...data };
  });
}
const graphOf = async (f) => collectGraphPayload(f.files, paths, researchNodes(f), f.core.current, []);
const repairOf = (payload, id) => payload.nodes.find((node) => node.id === id)?.repair;

test('the intake is a shared record, so every collaborator\'s dashboard shows the same repair', async () => {
  const f = fixture();
  await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 uses the key lemma at n = 0.');
  await f.core.intake(['main_theorem', 'key_lemma', 'natural'], { provider: 'claude', source: 'main.tex' });
  const [record] = decisions(f, 'intake');
  assert.deepEqual(record.data.ids, ['main_theorem', 'key_lemma', 'natural']);
  assert.deepEqual(record.data.main, ['main_theorem']);
  assert.equal(record.data.source, 'main.tex');
  const payload = await graphOf(f);
  assert.equal(payload.intakes.length, 1);
  assert.equal(payload.intakes[0].source, 'main.tex');
  assert.equal(repairOf(payload, 'main_theorem').state, 'needs_repair');
  assert.match(repairOf(payload, 'main_theorem').gap, /n = 0/);
  assert.equal(repairOf(payload, 'key_lemma').state, 'to_prove');
  assert.equal(repairOf(payload, 'natural'), undefined, 'definitions keep their usual card');
});

test('the repair view follows each result: repairing, its check, then waiting for review with the researcher\'s version to compare', async () => {
  const f = fixture();
  const next = await intakeToMain(f);
  assert.equal(next.stage, 'plan');
  let payload = await graphOf(f);
  assert.equal(repairOf(payload, 'main_theorem').state, 'repairing');
  assert.equal(repairOf(payload, 'main_theorem').active, true);
  const intake = payload.intakes[0].id;
  const view = repairPayload(payload, intake).nodes.find((node) => node.id === 'main_theorem');
  assert.equal(view.progress, 'working');
  assert.equal(view.progressLabel, 'Agent repairing');
  assert.deepEqual(repairGraph(payload, intake).nodes.map((node) => node.id).sort(), ['key_lemma', 'main_theorem']);
  assert.deepEqual(repairGraph(payload, intake).edges.map((edge) => `${edge.to}->${edge.from}`), ['key_lemma->main_theorem']);
  f.map.set('research/plans/main_repair.md', plan('main_theorem', 'Repair step 1'));
  await f.core.report({ outcome: 'complete', summary: 'Repair plan', planId: 'main_repair' });
  f.map.set(MAIN, asset('Main theorem', 'theorem', REPAIRED, { depends_on: ['key_lemma'] }));
  setPlan(f, 'main_repair', { status: 'succeeded' }, '## Outcome\n\nCovered n = 0.');
  await f.core.report({ outcome: 'proved', summary: 'Repaired step 1.' });
  payload = await graphOf(f);
  assert.equal(repairOf(payload, 'main_theorem').state, 'repairing', 'repaired, its check is next');
  assert.match(repairOf(payload, 'main_theorem').note, /check is next/);
  setPlan(f, 'main_repair', {}, '## Verdict\n\nconfirmed: n = 0 is now covered.');
  await f.core.report({ outcome: 'confirmed', summary: 'Sound.' });
  payload = await graphOf(f);
  const repair = repairOf(payload, 'main_theorem');
  assert.equal(repair.state, 'review');
  assert.equal(repair.how, 'repaired');
  assert.equal(repair.previous, PROOF);
  assert.equal(repair.proof, REPAIRED);
  assert.equal(repair.plan, 'main_repair');
});

test('a gap the researcher has not handed over waits for their call', async () => {
  const f = fixture();
  await f.core.recordExtractionCheck('main_theorem', 'rejected', 'Step 1 uses the key lemma at n = 0.');
  await f.core.intake(['main_theorem', 'key_lemma'], { provider: 'claude' });
  for (const [file] of [...f.map.entries()].filter(([file, raw]) => file.startsWith('research/decisions/') && /kind: repair_request/.test(raw))) f.map.delete(file);
  const payload = await graphOf(f);
  assert.equal(repairOf(payload, 'main_theorem').state, 'gap');
  assert.equal(repairPayload(payload, payload.intakes[0].id).nodes.find((node) => node.id === 'main_theorem').progress, 'needs_you');
});

test('once every result is settled the intake closes once, offers the conjectures from the researcher\'s work, and leads to a new goal', async () => {
  const f = fixture();
  f.map.set('research/assets/sharper_bound.md', matter.stringify('\n## Statement\n\nThe bound is sharp.\n\n## Motivation\n\nThe main theorem suggests it.\n', { type: 'conjecture', title: 'Sharper bound', status: 'draft', source: { kind: 'original' }, serves: ['main_theorem'], depends_on: [], uses_definitions: [], tags: [] }));
  await intakeToMain(f);
  f.map.set('research/plans/main_repair.md', plan('main_theorem', 'Repair step 1'));
  await f.core.report({ outcome: 'complete', summary: 'Repair plan', planId: 'main_repair' });
  f.map.set(MAIN, asset('Main theorem', 'theorem', REPAIRED, { depends_on: ['key_lemma'] }));
  setPlan(f, 'main_repair', { status: 'succeeded' }, '## Outcome\n\nCovered n = 0.');
  await f.core.report({ outcome: 'proved', summary: 'Repaired step 1.' });
  setPlan(f, 'main_repair', {}, '## Verdict\n\nconfirmed: n = 0 is now covered.');
  await f.core.report({ outcome: 'confirmed', summary: 'Sound.' });
  await f.core.next();
  assert.equal(decisions(f, 'intake_closed').length, 0, 'not before the researcher approves');
  for (const id of ['natural', 'key_lemma', 'main_theorem']) {
    const request = f.core.current.approvalQueue.find((item) => item.target === id);
    if (request) await f.core.resolveApproval(request.id, 'approved', '', 'test');
  }
  const next = await f.core.next();
  const [closed] = decisions(f, 'intake_closed');
  assert.ok(closed, next.instruction);
  assert.match(closed.content, /Repaired where the check found a gap: Main theorem/);
  assert.match(closed.content, /Proved here: Key lemma/);
  assert.deepEqual(closed.data.candidates, ['sharper_bound']);
  assert.match(next.instruction, /are settled/);
  assert.match(next.instruction, /Sharper bound \(sharper_bound\)/);
  assert.match(next.instruction, /extend --goal/);
  await f.core.next();
  assert.equal(decisions(f, 'intake_closed').length, 1, 'closed once');

  let payload = await graphOf(f);
  assert.equal(repairOf(payload, 'main_theorem').state, 'done');
  assert.equal(repairOf(payload, 'main_theorem').how, 'repaired');
  const handoff = payload.attention.find((item) => item.category === 'intake');
  assert.ok(handoff);
  assert.match(handoff.title, /choose the next research goal/);
  assert.deepEqual(handoff.buttons.map((button) => button.label), ['Take up “Sharper bound”', 'Set a new goal…']);
  assert.match(handoff.buttons[0].action.goal, /Take up the conjecture sharper_bound/);
  assert.deepEqual(handoff.buttons[1].action, { action: 'loop', op: 'extend' });

  // A new goal retires the hand-off card.
  f.map.set('research/project.md', projectMd(['main_theorem', 'sharper_bound']));
  payload = await graphOf(f);
  assert.equal(payload.attention.find((item) => item.category === 'intake'), undefined);
});

test('the proof comparison marks what the repair removed and added, in whole words', () => {
  const parts = wordDiff('By the key lemma, n = n.', 'By the key lemma, n = n, including n = 0.');
  assert.deepEqual(parts.filter((part) => part.kind !== 'same').map((part) => [part.kind, part.text.trim()]), [['removed', 'n.'], ['added', 'n, including n = 0.']]);
  assert.equal(parts.filter((part) => part.kind !== 'removed').map((part) => part.text).join(''), 'By the key lemma, n = n, including n = 0.');
  assert.equal(wordDiff('a '.repeat(3000), 'b '.repeat(3000)), undefined, 'too long to compare word by word');
});
