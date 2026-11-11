const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const matter = require('gray-matter');
const { decisionDocs, decisionData, handoffTexts, ideaRaw, logRecords } = require('./records-fixtures.cjs');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { ResearchLoopCore } = load('../src/services/ResearchLoopCore.ts');
const paths = { config: '.research-assistant.json', mainTex: 'main.tex', bibliography: 'references.bib', macroFiles: [], notations: null, sections: 'sections', researchRoot: 'research', projectMd: 'research/project.md', paperIndex: 'research/papers.md', assets: 'research/assets', definitions: 'research/definitions', ideas: 'research/ideas', plans: 'research/plans', writingRoot: 'research/writing', writingOutline: 'research/writing/outline.md', writingSections: 'research/writing/sections', papers: 'research/papers', localSourcePdfs: 'research-local/raw_papers' };
const SETTINGS = '.research-assistant-loop/settings.json';
const project = '---\ntype: project\nschema_version: 2\nrequired_results:\n  - id: main_theorem\n    role: the central claim\n---\n\n# Project\n\n## Main Problem\n\nProve A.\n\n## Scope and Assumptions\n\nNatural numbers.\n\n## Intended Contribution\n\nFind a proof.\n\n## Background\n\nNone.\n';
const result = (id, statement, extra = {}, proof = '') => matter.stringify(`\n## Statement\n\n${statement}\n${proof}`, { type: id === 'main_theorem' ? 'theorem' : 'lemma', title: id.replace(/_/g, ' '), status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: [], tags: [], ...extra });

function memoryFiles(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readFile: async (file) => { if (!map.has(file)) throw new Error(`missing ${file}`); return map.get(file); },
    writeFile: async (file, content) => { map.set(file, content); },
    exists: async (file) => map.has(file),
    listFiles: async (folder, extension = '.md') => [...map.keys()].filter((file) => path.posix.dirname(file) === folder && file.endsWith(extension)).sort(),
    deleteFile: async (file) => { map.delete(file); },
  };
}

let counter = 0;
function fixture(settings = {}) {
  const files = memoryFiles({
    'research/project.md': '# Project\n\n## Required Results\n', 'research/papers.md': '# Papers\n',
    [SETTINGS]: JSON.stringify({ version: 1, routeWidth: 2, ...settings, rigor: { refuteSearch: 'off', verifyProofs: 'off', verifyExtracted: 'off', agreeDefinitions: 'off', reviewRoutes: 'off', ...(settings.rigor ?? {}) } }),
  });
  const core = new ResearchLoopCore(files, paths, { id: () => `id-${++counter}`, iterationCap: 50 });
  return { files, core, map: files.map };
}

const read = (f, file) => matter(f.map.get(file));
const approve = async (f, kind, target) => {
  const request = f.core.current.approvalQueue.find((item) => item.kind === kind && item.target === target);
  assert.ok(request, `no ${kind} request for ${target}: ${JSON.stringify(f.core.current.approvalQueue.map((item) => `${item.kind}:${item.target}`))}`);
  await f.core.resolveApproval(request.id, 'approved', '', 'test');
};

async function driveToRoutes(f) {
  await f.core.start('claude', { goal: 'Prove the main theorem.' });
  f.map.set(paths.projectMd, project);
  await f.core.report({ outcome: 'complete', summary: 'Drafted' });
  // Autonomous mode approves the goals itself.
  if (f.core.current.approvalQueue.some((item) => item.kind === 'project')) await approve(f, 'project', 'project');
  assert.equal((await f.core.next()).stage, 'scaffold');
  f.map.set('research/assets/main_theorem.md', result('main_theorem', 'For every natural number n, A(n) holds.'));
  await f.core.report({ outcome: 'complete', summary: 'Scaffolded' });
  await f.core.report({ outcome: 'none', summary: 'No sources' });
}

const routeBody = (target, lemmas, difference = '') => `\n## Goal\n\nTarget: [${target}](../assets/${target}.md)\n\n## Route\n\n${lemmas.map((id) => `- ${id}: gives a step of the reduction.`).join('\n') || '- (direct)'}\n\n## Plan\n\n1. [ ] Combine the lemmas.\n\n## Verification\n\nThe lemmas give the statement.\n${difference}`;
const route = (target, lemmas, extra = {}, difference = '') => matter.stringify(routeBody(target, lemmas, difference), { type: 'plan', title: `Route to ${target}`, status: 'pending', target_asset: target, route_lemmas: lemmas, route_title: extra.route_title ?? `via ${lemmas.join(' and ') || 'a direct argument'}`, origin: 'agent', inspired_by: [], tags: [], ...extra });
const withReduction = (raw, text = 'Assume the lemmas; then A(n) follows for every n.') => { const parsed = matter(raw); return matter.stringify(`${parsed.content.trimEnd()}\n\n## Reduction\n\n${text}\n`, parsed.data); };
const planFile = (id) => `research/plans/${id}.md`;

/** Answer the routes question and get the round's slots. */
async function roundSlots(f, answer = '') {
  const result = await f.core.next();
  assert.equal(result.stage, 'route');
  const question = f.core.current.pendingQuestion;
  assert.equal(question?.kind, 'routes');
  await f.core.answerQuestion(question.id, answer ? 'answer' : 'skip', answer, 'test');
  const next = await f.core.next();
  assert.equal(next.stage, 'route');
  return f.core.current.current.route.slots;
}

/** Prove a classic lemma: plan, execute, and leave its proof for approval. */
async function proveClassic(f, id) {
  const selected = await f.core.next();
  assert.equal(selected.stage, 'plan', `expected a plan for ${id}, got ${selected.stage} (${f.core.current.current.assetId})`);
  assert.equal(f.core.current.current.assetId, id);
  const plan = `plan_${id}`;
  f.map.set(planFile(plan), matter.stringify(`\n## Goal\n\nTarget: [${id}](../assets/${id}.md)\n\n## Plan\n\n1. [ ] Prove it.\n\n## Verification\n\nDirect.\n`, { type: 'plan', title: plan, status: 'pending', target_asset: id, inspired_by: [], tags: [] }));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: plan });
  const asset = read(f, `research/assets/${id}.md`);
  f.map.set(`research/assets/${id}.md`, matter.stringify(`${asset.content.trimEnd()}\n\n## Proof\n\nBy induction (${++counter}).\n`, asset.data));
  f.map.set(planFile(plan), matter.stringify(`\n## Goal\n\nTarget: [${id}](../assets/${id}.md)\n\n## Plan\n\n1. [x] Prove it.\n\n## Verification\n\nDirect.\n\n## Outcome\n\nProof in ${id}.\n`, { type: 'plan', title: plan, status: 'succeeded', target_asset: id, inspired_by: [], tags: [] }));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
}

test('a main result not yet attempted gets a round of routes: the researcher is asked first, and their routes take the slots', async () => {
  const f = fixture({ routeWidth: 3 });
  await driveToRoutes(f);
  const slots = await roundSlots(f, 'first prove the energy bound, then the decay; via compactness');
  const ideas = [...f.map.keys()].filter((file) => file.startsWith('research/ideas/')).map((file) => read(f, file).data);
  assert.equal(ideas.length, 2, 'one researcher idea per route');
  assert.ok(ideas.every((idea) => idea.origin === 'researcher' && idea.idea_kind === 'approach' && idea.related_assets.includes('main_theorem')));
  assert.deepEqual(slots.map((slot) => slot.origin), ['researcher', 'researcher', 'agent'], 'the agent fills up to the routes per round');
  assert.equal(f.core.current.current.route.round, 1);
  // One pack per slot, like a search round.
  const next = await f.core.next();
  assert.match(next.instruction, /slot 1: \.research-assistant-loop\/context\/route-1\.md/);
  assert.match(f.map.get('.research-assistant-loop/context/route-1.md'), /Direction: Route to main_theorem: first prove the energy bound[\s\S]*### idea /);
  assert.doesNotMatch(f.map.get('.research-assistant-loop/context/route-1.md'), /via compactness/, 'each worker sees only its own route');
});

test('routes, merge, reduction first, shared lemma, commit: the winning route becomes the proof and the other is superseded', async () => {
  const f = fixture();
  await driveToRoutes(f);
  const slots = await roundSlots(f);
  assert.deepEqual(slots.map((slot) => slot.origin), ['agent', 'agent'], 'no researcher routes: the agent plans its own');
  // Slot 1: through the energy bound. Slot 2: the same bound under another name, and compactness.
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded.'));
  f.map.set('research/assets/energy_estimate.md', result('energy_estimate', 'The energy is bounded.'));
  f.map.set('research/assets/compactness.md', result('compactness', 'The family is compact.'));
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), route('main_theorem', ['energy_bound']));
  f.map.set(planFile('route_main_theorem_r1_s2_compact'), route('main_theorem', ['energy_estimate', 'compactness']));
  // Two routes in one slot are refused.
  f.map.set(planFile('route_main_theorem_r1_s1_other'), route('main_theorem', []));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Two routes' }), /slot 1 wrote 2 routes/);
  f.map.delete(planFile('route_main_theorem_r1_s1_other'));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  assert.equal(f.core.current.stage, 'route_merge');
  assert.equal(read(f, planFile('route_main_theorem_r1_s1_energy')).data.route_round, 1, 'the loop stamps the round');
  // Merge: the estimate is the bound.
  await assert.rejects(f.core.mergeRouteLemma('main_theorem', 'energy_bound'), /required result/);
  assert.match(await f.core.mergeRouteLemma('energy_estimate', 'energy_bound'), /merged into energy_bound/);
  assert.deepEqual(read(f, planFile('route_main_theorem_r1_s2_compact')).data.route_lemmas, ['energy_bound', 'compactness']);
  assert.equal(read(f, 'research/assets/energy_estimate.md').data.status, 'archived');
  assert.equal(read(f, 'research/assets/energy_estimate.md').data.merged_into, 'energy_bound');
  await f.core.report({ outcome: 'complete', summary: 'The energy estimate is the energy bound.' });
  assert.ok(decisionData(f.map).some((record) => record.kind === 'route_merge'));
  // The cheaper route goes first, and its reduction before its lemmas.
  assert.equal((await f.core.next()).stage, 'reduce');
  assert.equal(f.core.current.current.planId, 'route_main_theorem_r1_s1_energy');
  await assert.rejects(f.core.report({ outcome: 'proved', summary: 'Reduced' }), /## Reduction/);
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), withReduction(f.map.get(planFile('route_main_theorem_r1_s1_energy'))));
  await f.core.report({ outcome: 'proved', summary: 'Reduced' });
  const reduced = read(f, planFile('route_main_theorem_r1_s1_energy')).data;
  assert.ok(reduced.reduction_digest && reduced.reduction_verified_digest === reduced.reduction_digest, 'no independent check: the reduction stands as written');
  assert.ok(reduced.reduction_inputs.energy_bound && reduced.reduction_inputs.main_theorem);
  // Then the lemma both routes share, the classic way.
  await proveClassic(f, 'energy_bound');
  // Its proof waits for approval, which settles it for the route: the next selection commits the route.
  assert.equal((await f.core.next()).stage, 'waiting');
  const committed = read(f, 'research/assets/main_theorem.md');
  assert.match(committed.content, /## Proof\n\nAssume the lemmas; then A\(n\) follows/);
  assert.deepEqual(committed.data.depends_on, ['energy_bound']);
  assert.equal(committed.data.status, 'draft');
  const won = read(f, planFile('route_main_theorem_r1_s1_energy'));
  assert.equal(won.data.status, 'succeeded');
  assert.match(won.content, /## Outcome/);
  // The other route is superseded by derivation: its file (perhaps a collaborator's) is left untouched.
  assert.equal(read(f, planFile('route_main_theorem_r1_s2_compact')).data.status, 'pending');
  const after = (await f.core.routeStatus('main_theorem')).routes.find((item) => item.planId === 'route_main_theorem_r1_s2_compact');
  assert.deepEqual([after.state, after.supersededBy], ['superseded', 'route_main_theorem_r1_s1_energy']);
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'asset' && item.target === 'main_theorem'), 'the committed proof goes to review');
  await approve(f, 'asset', 'energy_bound');
  await approve(f, 'asset', 'main_theorem');
  // The superseded route's own lemma is out of scope now: nothing waits on compactness.
  assert.equal((await f.core.next()).stage, 'ready');
});

test('a failed route leaves the others; when every route failed and the rounds are used up, the researcher gives a direction, which starts a new round', async () => {
  const f = fixture({ routeRounds: 1, routeWidth: 1 });
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set(planFile('route_main_theorem_r1_s1_direct'), route('main_theorem', []));
  await f.core.report({ outcome: 'complete', summary: 'One route' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal((await f.core.next()).stage, 'reduce');
  const failed = matter(f.map.get(planFile('route_main_theorem_r1_s1_direct')));
  f.map.set(planFile('route_main_theorem_r1_s1_direct'), matter.stringify(`${failed.content.trimEnd()}\n\n## Failure\n\nThe direct argument needs a bound nobody has.\n`, { ...failed.data, status: 'failed' }));
  await f.core.report({ outcome: 'failed', summary: 'No bound' });
  // The one round allowed is used: ask for a direction.
  await f.core.next();
  const question = f.core.current.pendingQuestion;
  assert.equal(question?.kind, 'blocked');
  assert.equal(question.assetId, 'main_theorem');
  await f.core.answerQuestion(question.id, 'answer', 'Try a monotonicity formula.', 'test');
  // The direction resets the round count and becomes a slot of the next round.
  const result = await f.core.next();
  assert.equal(result.stage, 'route');
  assert.equal(f.core.current.current.route.round, 2);
  const routesQuestion = f.core.current.pendingQuestion;
  await f.core.answerQuestion(routesQuestion.id, 'skip', '', 'test');
  await f.core.next();
  assert.deepEqual(f.core.current.current.route.slots.map((slot) => [slot.direction, slot.origin, slot.label]), [['direction', 'researcher', 'Try a monotonicity formula.']]);
  // A new route must say how it differs from the failed one.
  f.map.set(planFile('route_main_theorem_r2_s1_mono'), route('main_theorem', [], { origin: 'researcher' }));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Monotonicity' }), /Difference from failed plans must mention route_main_theorem_r1_s1_direct/);
  f.map.set(planFile('route_main_theorem_r2_s1_mono'), route('main_theorem', [], { origin: 'researcher' }, '\n## Difference from failed plans\n\n- route_main_theorem_r1_s1_direct: monotonicity replaces the missing bound.\n'));
  await f.core.report({ outcome: 'complete', summary: 'Monotonicity' });
  assert.equal(f.core.current.stage, 'route_merge');
});

test('the route map waits for the researcher when they review maps; a failed route leaves it approved, a new route needs a new review', async () => {
  const f = fixture({ rigor: { reviewRoutes: 'main' } });
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded.'));
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), route('main_theorem', ['energy_bound']));
  f.map.set(planFile('route_main_theorem_r1_s2_direct'), route('main_theorem', []));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  const merged = await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal(merged.stage, 'review_routes');
  assert.match(merged.message, /request_approval\(kind: "routes"/);
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'routes' && item.target === 'main_theorem'));
  assert.equal((await f.core.next()).stage, 'waiting', 'nothing else to do while the map is reviewed');
  await approve(f, 'routes', 'main_theorem');
  const record = [...f.map.entries()].find(([file]) => file.startsWith('research/approvals/routes/'));
  assert.ok(record, 'route map approvals live in their own folder');
  assert.deepEqual(Object.keys(JSON.parse(record[1]).nodes).sort(), ['route_main_theorem_r1_s1_energy', 'route_main_theorem_r1_s2_direct']);
  // The direct route is cheapest: its reduction first. It fails.
  assert.equal((await f.core.next()).stage, 'reduce');
  assert.equal(f.core.current.current.planId, 'route_main_theorem_r1_s2_direct');
  const direct = matter(f.map.get(planFile('route_main_theorem_r1_s2_direct')));
  f.map.set(planFile('route_main_theorem_r1_s2_direct'), matter.stringify(`${direct.content.trimEnd()}\n\n## Failure\n\nNo direct argument.\n`, { ...direct.data, status: 'failed' }));
  await f.core.report({ outcome: 'failed', summary: 'No direct argument' });
  // No new review for a route that left the map.
  assert.equal((await f.core.next()).stage, 'reduce');
  assert.equal(f.core.current.current.planId, 'route_main_theorem_r1_s1_energy');
  // A route the researcher adds later is a change to the map: reviewed again.
  // (A route with the same lemmas and ## Route would be a copy, covered by the review already.)
  f.map.set('research/assets/decay.md', result('decay', 'The solution decays.'));
  f.map.set(planFile('route_main_theorem_r1_s9_late'), route('main_theorem', ['decay'], { route_title: 'a late route' }));
  f.core.current.stage = 'select';
  assert.equal((await f.core.next()).stage, 'waiting');
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'routes' && item.target === 'main_theorem'));
});

test('asking for other routes drops the open ones and makes the researcher\'s words the next direction', async () => {
  const f = fixture({ rigor: { reviewRoutes: 'main' } });
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set(planFile('route_main_theorem_r1_s1_direct'), route('main_theorem', []));
  await f.core.report({ outcome: 'complete', summary: 'One route' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  const request = f.core.current.approvalQueue.find((item) => item.kind === 'routes');
  await f.core.resolveApproval(request.id, 'changes_requested', 'Use the maximum principle instead.', 'test');
  assert.equal(read(f, planFile('route_main_theorem_r1_s1_direct')).data.status, 'abandoned');
  assert.ok(decisionData(f.map).some((record) => record.kind === 'route_drop'));
  assert.equal((await f.core.next()).stage, 'route');
  await f.core.answerQuestion(f.core.current.pendingQuestion.id, 'skip', '', 'test');
  await f.core.next();
  assert.equal(f.core.current.current.route.slots[0].label, 'Use the maximum principle instead.');
});

test('an independent check of the reduction: confirmed, the committed proof counts as verified; rejected, the route fails', async () => {
  const f = fixture({ rigor: { verifyProofs: 'agent' } });
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set(planFile('route_main_theorem_r1_s1_direct'), route('main_theorem', []));
  f.map.set(planFile('route_main_theorem_r1_s2_other'), route('main_theorem', [], { route_title: 'another direct one' }));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal((await f.core.next()).stage, 'reduce');
  const first = f.core.current.current.planId;
  f.map.set(planFile(first), withReduction(f.map.get(planFile(first))));
  await f.core.report({ outcome: 'proved', summary: 'Reduced' });
  assert.equal((await f.core.next()).stage, 'verify_reduction');
  const plan = matter(f.map.get(planFile(first)));
  // The check may not touch the reduction.
  f.map.set(planFile(first), matter.stringify(`${plan.content.replace('follows', 'clearly follows')}\n## Reduction verdict\n\nconfirmed\n`, plan.data));
  await assert.rejects(f.core.report({ outcome: 'confirmed', summary: 'ok' }), /Reduction unchanged/);
  f.map.set(planFile(first), matter.stringify(`${plan.content.trimEnd()}\n\n## Reduction verdict\n\nrejected: step 1 assumes what it proves.\n`, plan.data));
  await f.core.report({ outcome: 'rejected', summary: 'Circular' });
  assert.equal(read(f, planFile(first)).data.status, 'failed');
  assert.match(read(f, planFile(first)).content, /## Failure\n\nThe independent check rejected the reduction/);
  // The other route: reduced, confirmed, committed (no lemmas), and its proof is not checked a second time.
  assert.equal((await f.core.next()).stage, 'reduce');
  const second = f.core.current.current.planId;
  assert.notEqual(second, first);
  f.map.set(planFile(second), withReduction(f.map.get(planFile(second))));
  await f.core.report({ outcome: 'proved', summary: 'Reduced' });
  assert.equal((await f.core.next()).stage, 'verify_reduction');
  const again = matter(f.map.get(planFile(second)));
  f.map.set(planFile(second), matter.stringify(`${again.content.trimEnd()}\n\n## Reduction verdict\n\nconfirmed: every step holds.\n`, again.data));
  await f.core.report({ outcome: 'confirmed', summary: 'Holds' });
  const after = await f.core.next();
  assert.equal(read(f, planFile(second)).data.status, 'succeeded');
  assert.equal(read(f, planFile(second)).data.verified_proof_digest, read(f, planFile(second)).data.proof_digest);
  assert.notEqual(after.stage, 'verify_proof');
  assert.ok(f.core.current.approvalQueue.some((item) => item.kind === 'asset' && item.target === 'main_theorem'));
});

test('a lemma refuted by a confirmed counterexample kills its route; a lemma changed after the reduction voids the reduction', async () => {
  const f = fixture();
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded.'));
  f.map.set('research/assets/decay.md', result('decay', 'The solution decays.'));
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), route('main_theorem', ['energy_bound']));
  f.map.set(planFile('route_main_theorem_r1_s2_decay'), route('main_theorem', ['decay', 'energy_bound']));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal((await f.core.next()).stage, 'reduce');
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), withReduction(f.map.get(planFile('route_main_theorem_r1_s1_energy'))));
  await f.core.report({ outcome: 'proved', summary: 'Reduced' });
  // The lemma's statement changes: the reduction rested on the old one, so it is written again.
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded by the initial energy.'));
  f.core.current.stage = 'select';
  assert.equal((await f.core.next()).stage, 'reduce');
  assert.equal(f.core.current.current.planId, 'route_main_theorem_r1_s1_energy');
  // A confirmed counterexample to the energy bound kills both routes through it.
  f.map.set('research/assets/energy_counterexample.md', matter.stringify('\n## Statement\n\nA solution with unbounded energy.\n', { type: 'example', title: 'Unbounded energy', status: 'approved', refutes: 'energy_bound', depends_on: [], uses_definitions: [], tags: [] }));
  const status = await f.core.routeStatus('main_theorem');
  assert.deepEqual(status.routes.map((item) => [item.planId, item.state, item.death?.lemma]), [['route_main_theorem_r1_s1_energy', 'dead', 'energy_bound'], ['route_main_theorem_r1_s2_decay', 'dead', 'energy_bound']]);
  assert.match(status.text, /energy_bound refuted/);
});

test('autonomous mode plans routes without asking; a fork starts every route from a proved result', async () => {
  const f = fixture({ autonomy: { enabled: true }, autonomyBudget: 50 });
  await driveToRoutes(f);
  assert.equal((await f.core.next()).stage, 'route');
  assert.equal(f.core.current.pendingQuestion, undefined, 'never asks in autonomous mode');
  assert.equal(f.core.current.current.route.slots.length, 2);
  // Fork: only from a settled result.
  f.map.set('research/assets/monotonicity.md', result('monotonicity', 'The quantity is monotone.'));
  await assert.rejects(f.core.requestRoutes('main_theorem', 'monotonicity'), /not approved yet/);
  f.map.set('research/assets/monotonicity.md', result('monotonicity', 'The quantity is monotone.', { status: 'approved' }));
  await f.core.adoptExistingApprovals();
  assert.match(await f.core.requestRoutes('main_theorem', 'monotonicity'), /starting from monotonicity/);
  f.core.current.stage = 'select';
  assert.equal((await f.core.next()).stage, 'route');
  const round = f.core.current.current.route;
  assert.equal(round.fork, 'monotonicity');
  assert.ok(round.slots.every((slot) => slot.origin === 'fork' && /^Start from monotonicity/.test(slot.label)));
  f.map.set(planFile(`route_main_theorem_r${round.round}_s1_mono`), route('main_theorem', ['monotonicity'], { origin: 'fork' }));
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'From monotonicity' }), /forked_from/);
  f.map.set(planFile(`route_main_theorem_r${round.round}_s1_mono`), route('main_theorem', ['monotonicity'], { origin: 'fork', forked_from: 'monotonicity' }));
  await f.core.report({ outcome: 'complete', summary: 'From monotonicity' });
  assert.equal(f.core.current.stage, 'route_merge');
});

test('with routes off, a main result is planned the classic way; a result with open routes keeps them', async () => {
  const f = fixture({ routeWidth: 0 });
  await driveToRoutes(f);
  assert.equal((await f.core.next()).stage, 'plan');
  // Routes written earlier stay worked on even after routes are turned off.
  f.core.current.stage = 'select';
  f.map.set(planFile('route_main_theorem_r1_s1_direct'), route('main_theorem', [], { route_round: 1 }));
  assert.equal((await f.core.next()).stage, 'reduce');
});

test('merging: a stronger lemma gives the weaker one a route of its own; the researcher may drop a route', async () => {
  const f = fixture();
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set('research/assets/compactness.md', result('compactness', 'The family is compact.'));
  f.map.set('research/assets/strong_compactness.md', result('strong_compactness', 'The family is compact in the strong topology.'));
  f.map.set(planFile('route_main_theorem_r1_s1_weak'), route('main_theorem', ['compactness']));
  f.map.set(planFile('route_main_theorem_r1_s2_strong'), route('main_theorem', ['strong_compactness']));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  // Merge commands only during the merge stage.
  assert.match(await f.core.implyRouteLemma('strong_compactness', 'compactness', 'the strong topology is finer'), /route_compactness_from_strong_compactness/);
  const implied = read(f, planFile('route_compactness_from_strong_compactness'));
  assert.deepEqual([implied.data.target_asset, implied.data.route_lemmas, implied.data.status], ['compactness', ['strong_compactness'], 'pending']);
  await assert.rejects(f.core.implyRouteLemma('compactness', 'strong_compactness'), /equivalent, so merge them/);
  await f.core.report({ outcome: 'complete', summary: 'Strong compactness implies compactness.' });
  await assert.rejects(f.core.mergeRouteLemma('compactness', 'strong_compactness'), /only during stage route_merge/);
  // The researcher drops the strong route.
  await assert.rejects(f.core.dropRoute('route_main_theorem_r1_s2_strong', ''), /--reason/);
  assert.match(await f.core.dropRoute('route_main_theorem_r1_s2_strong', 'The strong topology is not what we want.'), /dropped/);
  assert.equal(read(f, planFile('route_main_theorem_r1_s2_strong')).data.status, 'abandoned');
  const status = await f.core.routeStatus('main_theorem');
  assert.deepEqual(status.routes.map((item) => [item.planId, item.state]), [['route_main_theorem_r1_s1_weak', 'live'], ['route_main_theorem_r1_s2_strong', 'abandoned']]);
});

test('with "try several routes first", a stuck lemma gets a round of routes before the researcher is asked', async () => {
  const f = fixture({ rigor: { lemmaRoutes: 'on' }, maxFailedPlans: 1 });
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded.'));
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), route('main_theorem', ['energy_bound']));
  await f.core.report({ outcome: 'complete', summary: 'One route' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal((await f.core.next()).stage, 'reduce');
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), withReduction(f.map.get(planFile('route_main_theorem_r1_s1_energy'))));
  await f.core.report({ outcome: 'proved', summary: 'Reduced' });
  assert.equal((await f.core.next()).stage, 'plan');
  assert.equal(f.core.current.current.assetId, 'energy_bound');
  f.map.set(planFile('plan_energy'), matter.stringify('\n## Goal\n\nTarget: [energy_bound](../assets/energy_bound.md)\n\n## Plan\n\n1. [ ] Bound it.\n\n## Verification\n\nDirect.\n', { type: 'plan', title: 'plan_energy', status: 'pending', target_asset: 'energy_bound', inspired_by: [], tags: [] }));
  await f.core.report({ outcome: 'complete', summary: 'Planned', planId: 'plan_energy' });
  f.map.set(planFile('plan_energy'), matter.stringify('\n## Goal\n\nTarget: [energy_bound](../assets/energy_bound.md)\n\n## Plan\n\n1. [ ] Bound it.\n\n## Verification\n\nDirect.\n\n## Failure\n\nThe bound needs more than the energy identity.\n', { type: 'plan', title: 'plan_energy', status: 'failed', target_asset: 'energy_bound', inspired_by: [], tags: [] }));
  const failed = await f.core.report({ outcome: 'failed', summary: 'Not enough' });
  assert.match(failed.message, /several routes to energy_bound/);
  assert.equal(f.core.current.pendingQuestion, undefined, 'not asked yet');
  assert.equal((await f.core.next()).stage, 'route');
  assert.equal(f.core.current.current.route.target, 'energy_bound');
});

// ---------- batches: several workers at once ----------

async function twoRoutes(f) {
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded.'));
  f.map.set('research/assets/compactness.md', result('compactness', 'The family is compact.'));
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), route('main_theorem', ['energy_bound']));
  f.map.set(planFile('route_main_theorem_r1_s2_compact'), route('main_theorem', ['energy_bound', 'compactness']));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
}

test('with several workers, the two reductions and the shared lemma are worked on side by side and reported item by item', async () => {
  const f = fixture({ parallelWorkers: 3 });
  await twoRoutes(f);
  const result = await f.core.next();
  assert.equal(result.stage, 'batch');
  const items = f.core.current.current.batch.items;
  // The cheapest route's reduction; its lemma (shared) while that is being written; then the other route's reduction.
  assert.deepEqual(items.map((item) => [item.stage, item.planId ?? item.assetId]), [
    ['reduce', 'route_main_theorem_r1_s1_energy'], ['plan', 'energy_bound'], ['reduce', 'route_main_theorem_r1_s2_compact'],
  ]);
  assert.match(result.instruction, /Item 1: Stage reduce for the route route_main_theorem_r1_s1_energy[\s\S]*--item 1 --summary/);
  assert.match(result.instruction, /Item 2: Stage plan for asset energy_bound[\s\S]*--item 2 --summary/);
  assert.match(result.instruction, /item 3: \.research-assistant-loop\/context\/item-3\.md/);
  assert.match(f.map.get('.research-assistant-loop/context/item-1.md'), /stage reduce/);
  assert.match(f.map.get('.research-assistant-loop/context/item-2.md'), /stage plan/);
  // Each reduction froze its own inputs.
  assert.ok(items[0].inputs.some((input) => input.id === 'energy_bound'));
  // The workers write, all at once.
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), withReduction(f.map.get(planFile('route_main_theorem_r1_s1_energy'))));
  const second = matter(f.map.get(planFile('route_main_theorem_r1_s2_compact')));
  f.map.set(planFile('route_main_theorem_r1_s2_compact'), matter.stringify(`${second.content.trimEnd()}\n\n## Failure\n\nCompactness does not give the limit.\n`, { ...second.data, status: 'failed' }));
  f.map.set(planFile('plan_energy'), matter.stringify('\n## Goal\n\nTarget: [energy_bound](../assets/energy_bound.md)\n\n## Plan\n\n1. [ ] Bound it.\n\n## Verification\n\nDirect.\n', { type: 'plan', title: 'plan_energy', status: 'pending', target_asset: 'energy_bound', inspired_by: [], tags: [] }));
  // Reports: an item number is required, once each, in any order.
  await assert.rejects(f.core.report({ outcome: 'failed', summary: 'x' }), /report each item with --item/);
  await assert.rejects(f.core.report({ outcome: 'failed', summary: 'x', item: 9 }), /No item 9/);
  const r3 = await f.core.report({ outcome: 'failed', summary: 'Compactness does not give the limit', item: 3 });
  assert.equal(r3.stage, 'batch');
  assert.match(r3.message, /Still to report: item\(s\) 1, 2/);
  assert.equal(JSON.parse(f.map.get('.research-assistant-loop/state.json')).stage, 'batch', 'state.json keeps the batch between item reports');
  await assert.rejects(f.core.report({ outcome: 'failed', summary: 'x', item: 3 }), /reported already/);
  await f.core.report({ outcome: 'complete', summary: 'Planned', item: 2, planId: 'plan_energy' });
  assert.equal(read(f, planFile('plan_energy')).data.status, 'pending');
  const r1 = await f.core.report({ outcome: 'proved', summary: 'Reduced', item: 1 });
  assert.equal(r1.stage, 'select');
  assert.match(r1.message, /Every item of the batch is reported/);
  assert.ok(read(f, planFile('route_main_theorem_r1_s1_energy')).data.reduction_verified_digest);
  assert.equal(read(f, planFile('route_main_theorem_r1_s2_compact')).data.status, 'failed');
  // Next: the planned lemma is executed (alone now: nothing else is open).
  const next = await f.core.next();
  assert.equal(next.stage, 'plan');
  assert.equal(f.core.current.current.planId, 'plan_energy', 'the plan written in the batch is executed next');
});

test('in a batch, each item may change only its own files, and a change no item owns stops the last report', async () => {
  const f = fixture({ parallelWorkers: 2 });
  await twoRoutes(f);
  assert.equal((await f.core.next()).stage, 'batch');
  const [first, second] = f.core.current.current.batch.items;
  assert.deepEqual([first.stage, second.stage], ['reduce', 'plan']);
  f.map.set(planFile(first.planId), withReduction(f.map.get(planFile(first.planId))));
  f.map.set(planFile('plan_energy'), matter.stringify('\n## Goal\n\nTarget: [energy_bound](../assets/energy_bound.md)\n\n## Plan\n\n1. [ ] Bound it.\n\n## Verification\n\nDirect.\n', { type: 'plan', title: 'plan_energy', status: 'pending', target_asset: 'energy_bound', inspired_by: [], tags: [] }));
  // A worker also edits a lemma's statement: no item owns it.
  f.map.set('research/assets/compactness.md', result('compactness', 'The family is precompact.'));
  await f.core.report({ outcome: 'proved', summary: 'Reduced', item: 1 });
  await assert.rejects(f.core.report({ outcome: 'complete', summary: 'Planned', item: 2, planId: 'plan_energy' }), /files no item owns[\s\S]*compactness\.md/);
  f.map.set('research/assets/compactness.md', result('compactness', 'The family is compact.'));
  const closed = await f.core.report({ outcome: 'complete', summary: 'Planned', item: 2, planId: 'plan_energy' });
  assert.equal(closed.stage, 'select');
});

test('autonomous mode pays one attempt per reduction in a batch', async () => {
  const f = fixture({ parallelWorkers: 2, autonomy: { enabled: true }, autonomyBudget: 50 });
  await driveToRoutes(f);
  await f.core.next();
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded.'));
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), route('main_theorem', ['energy_bound']));
  f.map.set(planFile('route_main_theorem_r1_s2_direct'), route('main_theorem', []));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal((await f.core.next()).stage, 'batch');
  const spent = f.core.current.autonomy.spent;
  for (const item of f.core.current.current.batch.items) {
    if (item.stage !== 'reduce') continue;
    f.map.set(planFile(item.planId), withReduction(f.map.get(planFile(item.planId))));
  }
  const reduces = f.core.current.current.batch.items.filter((item) => item.stage === 'reduce');
  for (const item of f.core.current.current.batch.items) {
    if (item.stage === 'reduce') await f.core.report({ outcome: 'proved', summary: 'Reduced', item: item.item });
    else if (item.stage === 'plan') {
      f.map.set(planFile(`plan_${item.assetId}`), matter.stringify(`\n## Goal\n\nTarget: [${item.assetId}](../assets/${item.assetId}.md)\n\n## Plan\n\n1. [ ] Do it.\n\n## Verification\n\nDirect.\n`, { type: 'plan', title: 'p', status: 'pending', target_asset: item.assetId, inspired_by: [], tags: [] }));
      await f.core.report({ outcome: 'complete', summary: 'Planned', item: item.item, planId: `plan_${item.assetId}` });
    }
  }
  assert.equal(f.core.current.autonomy.spent, spent + reduces.length);
});

test('one worker, or one item to work on: no batch', async () => {
  const f = fixture({ parallelWorkers: 1 });
  await twoRoutes(f);
  assert.equal((await f.core.next()).stage, 'reduce');
  const g = fixture({ parallelWorkers: 3, routeWidth: 1 });
  await driveToRoutes(g);
  await roundSlots(g);
  g.map.set(planFile('route_main_theorem_r1_s1_direct'), route('main_theorem', []));
  await g.core.report({ outcome: 'complete', summary: 'One direct route' });
  await g.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal((await g.core.next()).stage, 'reduce', 'a single item runs as an ordinary stage');
});

test('two lemmas of one route are planned side by side, then executed side by side; the route is then committed', async () => {
  const f = fixture({ parallelWorkers: 2, routeWidth: 1 });
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set('research/assets/lemma_a.md', result('lemma_a', 'A holds.'));
  f.map.set('research/assets/lemma_b.md', result('lemma_b', 'B holds.'));
  f.map.set(planFile('route_main_theorem_r1_s1_ab'), route('main_theorem', ['lemma_a', 'lemma_b']));
  await f.core.report({ outcome: 'complete', summary: 'One route' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  // Batch 1: the reduction, and a lemma meanwhile.
  assert.equal((await f.core.next()).stage, 'batch');
  assert.deepEqual(f.core.current.current.batch.items.map((item) => item.stage), ['reduce', 'plan']);
  f.map.set(planFile('route_main_theorem_r1_s1_ab'), withReduction(f.map.get(planFile('route_main_theorem_r1_s1_ab'))));
  const planFor = (id, status = 'pending', extra = '') => matter.stringify(`\n## Goal\n\nTarget: [${id}](../assets/${id}.md)\n\n## Plan\n\n1. [${status === 'succeeded' ? 'x' : ' '}] Prove it.\n\n## Verification\n\nDirect.\n${extra}`, { type: 'plan', title: `plan_${id}`, status, target_asset: id, inspired_by: [], tags: [] });
  const second = f.core.current.current.batch.items[1].assetId;
  f.map.set(planFile(`plan_${second}`), planFor(second));
  await f.core.report({ outcome: 'proved', summary: 'Reduced', item: 1 });
  await f.core.report({ outcome: 'complete', summary: 'Planned', item: 2, planId: `plan_${second}` });
  // Batch 2: the planned lemma is executed while the other is planned.
  assert.equal((await f.core.next()).stage, 'batch');
  const items = f.core.current.current.batch.items;
  const execute = items.find((item) => item.stage === 'execute');
  const plan = items.find((item) => item.stage === 'plan');
  assert.equal(execute.assetId, second);
  assert.equal(execute.planId, `plan_${second}`);
  assert.ok(execute.statementDigest, 'the statement is frozen for the execution');
  const other = plan.assetId;
  const proved = (id) => { const asset = read(f, `research/assets/${id}.md`); f.map.set(`research/assets/${id}.md`, matter.stringify(`${asset.content.trimEnd()}\n\n## Proof\n\nDirect (${id}).\n`, asset.data)); };
  proved(second);
  f.map.set(planFile(`plan_${second}`), planFor(second, 'succeeded', '\n## Outcome\n\nProof in the asset.\n'));
  f.map.set(planFile(`plan_${other}`), planFor(other));
  // The execution may not change its statement; the check sees only its own files.
  await f.core.report({ outcome: 'proved', summary: 'Proved', item: execute.item });
  await f.core.report({ outcome: 'complete', summary: 'Planned', item: plan.item, planId: `plan_${other}` });
  // Then the last lemma alone (an ordinary stage), and the route is committed.
  assert.equal((await f.core.next()).stage, 'plan');
  await f.core.report({ outcome: 'complete', summary: 'Execute', planId: `plan_${other}` });
  proved(other);
  f.map.set(planFile(`plan_${other}`), planFor(other, 'succeeded', '\n## Outcome\n\nProof in the asset.\n'));
  await f.core.report({ outcome: 'proved', summary: 'Proved' });
  await f.core.next();
  assert.deepEqual(read(f, 'research/assets/main_theorem.md').data.depends_on, ['lemma_a', 'lemma_b']);
  assert.equal(read(f, planFile('route_main_theorem_r1_s1_ab')).data.status, 'succeeded');
});

test('a budget used up mid-batch ends the autonomous run only once the batch is reported', async () => {
  const f = fixture({ parallelWorkers: 2, autonomy: { enabled: true }, autonomyBudget: 50 });
  await driveToRoutes(f);
  await f.core.next();
  f.map.set(planFile('route_main_theorem_r1_s1_a'), route('main_theorem', []));
  f.map.set(planFile('route_main_theorem_r1_s2_b'), route('main_theorem', [], { route_title: 'another direct one' }));
  await f.core.report({ outcome: 'complete', summary: 'Two routes' });
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  assert.equal((await f.core.next()).stage, 'batch');
  // Leave room for exactly one more attempt.
  const settings = JSON.parse(f.map.get(SETTINGS));
  f.map.set(SETTINGS, JSON.stringify({ ...settings, autonomyBudget: f.core.current.autonomy.spent + 1 }));
  const [first, second] = f.core.current.current.batch.items;
  for (const item of [first, second]) {
    const plan = matter(f.map.get(planFile(item.planId)));
    f.map.set(planFile(item.planId), matter.stringify(`${plan.content.trimEnd()}\n\n## Failure\n\nNo.\n`, { ...plan.data, status: 'failed' }));
  }
  const one = await f.core.report({ outcome: 'failed', summary: 'No', item: first.item });
  assert.equal(one.stage, 'batch', 'the budget is spent, but the batch goes on');
  assert.equal(f.core.current.status, 'running');
  const two = await f.core.report({ outcome: 'failed', summary: 'No', item: second.item });
  assert.equal(f.core.current.status, 'paused', 'the run ends once the batch is reported');
  assert.ok(f.core.current.autonomy.handedOverAt);
  assert.notEqual(two.stage, 'batch');
});

test('collaborators: a route is reduced by its creator, others copy it; the owner of the result commits; merges and drops touch only your own routes', async () => {
  const f = fixture({ routeWidth: 1 });
  await driveToRoutes(f);
  await roundSlots(f);
  f.map.set('research/assets/energy_bound.md', result('energy_bound', 'The energy is bounded.'));
  f.map.set(planFile('route_main_theorem_r1_s1_energy'), route('main_theorem', ['energy_bound']));
  await f.core.report({ outcome: 'complete', summary: 'One route' });
  const me = read(f, planFile('route_main_theorem_r1_s1_energy')).data.created_by;
  assert.ok(me, 'the loop stamps who created the route');
  await f.core.report({ outcome: 'complete', summary: 'Nothing to merge' });
  // Alice's route arrives through a sync: this loop does not reduce it.
  f.map.set(planFile('route_main_theorem_r1_alice'), route('main_theorem', [], { created_by: 'alice@example.edu', route_title: 'Alice direct', route_round: 1 }));
  assert.equal((await f.core.next()).stage, 'reduce');
  assert.equal(f.core.current.current.planId, 'route_main_theorem_r1_s1_energy', 'Alice\'s cheaper route is hers to reduce');
  await assert.rejects(f.core.dropRoute('route_main_theorem_r1_alice', 'not mine'), /alice@example.edu's route/);
  // Copying it gives a route of mine with the same lemmas and no reduction; a copy of a reviewed route needs no new review.
  f.map.set(planFile('route_main_theorem_r1_alice'), withReduction(f.map.get(planFile('route_main_theorem_r1_alice')), 'Alice\'s argument.'));
  assert.match(await f.core.copyRoute('route_main_theorem_r1_alice'), /copied to route_main_theorem_r1_alice_copy_/);
  const copyFile = [...f.map.keys()].find((file) => file.includes('route_main_theorem_r1_alice_copy_'));
  const copy = read(f, copyFile);
  assert.deepEqual([copy.data.origin, copy.data.copied_from, copy.data.created_by, copy.data.route_lemmas], ['copy', 'route_main_theorem_r1_alice', me, []]);
  assert.doesNotMatch(copy.content, /## Reduction/);
  // Only the owner commits: with Bob as the owner of the main theorem, my complete route waits for him.
  f.map.set(paths.projectMd, project.replace('    role: the central claim\n', '    role: the central claim\n    owner: bob@example.edu\n'));
  await f.core.adoptExistingApprovals();
  f.core.current.stage = 'select';
  const plan = path.posix.basename(copyFile, '.md');
  assert.equal((await f.core.next()).stage, 'reduce');
  assert.equal(f.core.current.current.planId, plan);
  f.map.set(copyFile, withReduction(f.map.get(copyFile)));
  await f.core.report({ outcome: 'proved', summary: 'Reduced' });
  const next = await f.core.next();
  assert.notEqual(read(f, 'research/assets/main_theorem.md').content.includes('## Proof'), true, 'not committed: Bob owns the result');
  const status = await f.core.routeStatus('main_theorem');
  assert.match(status.text, /0 step\(s\) left|reduced/);
  assert.ok(next.stage);
});
