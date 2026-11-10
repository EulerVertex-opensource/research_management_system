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

const routes = load('../src/domain/routes.ts');
const { nodeProblems } = load('../src/domain/schema.ts');

const ROUTE_BODY = '\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\n## Route\n\n- lemma_a: gives the bound.\n- lemma_b: closes the argument.\n\n## Plan\n\n1. [ ] Combine the lemmas.\n\n## Verification\n\nThe lemmas give the statement.\n';
const routeData = (extra = {}) => ({ type: 'plan', title: 'Route', status: 'pending', target_asset: 'main_theorem', route_lemmas: ['lemma_a', 'lemma_b'], route_title: 'via the bound', origin: 'agent', inspired_by: [], tags: [], ...extra });
const problems = (data, body = ROUTE_BODY) => nodeProblems('plan', 'route_1', data, body);

test('a route plan carries route_lemmas, a title, an origin, and a ## Route', () => {
  assert.deepEqual(problems(routeData()), []);
  assert.equal(routes.isRoutePlan(routeData()), true);
  assert.equal(routes.isRoutePlan(routeData({ route_lemmas: [] })), true, 'an empty list is a direct route');
  assert.equal(routes.isRoutePlan({ type: 'plan', status: 'pending' }), false);
  assert.match(problems(routeData({ route_title: '' })).join('\n'), /route_title/);
  assert.match(problems(routeData({ origin: 'someone' })).join('\n'), /origin researcher\|agent\|fork/);
  assert.match(problems(routeData({ route_lemmas: ['lemma_a', 'lemma_a'] })).join('\n'), /twice/);
  assert.match(problems(routeData({ route_lemmas: ['main_theorem'] })).join('\n'), /own target/);
  assert.match(problems(routeData(), ROUTE_BODY.replace(/## Route[\s\S]*?(?=## Plan)/, '')).join('\n'), /## Route/);
  // A fork starts from a settled result and must use it.
  assert.match(problems(routeData({ origin: 'fork' })).join('\n'), /forked_from/);
  assert.match(problems(routeData({ origin: 'fork', forked_from: 'monotonicity' })).join('\n'), /list monotonicity in route_lemmas/);
  assert.deepEqual(problems(routeData({ origin: 'fork', forked_from: 'lemma_a' })), []);
  assert.match(problems(routeData({ forked_from: 'lemma_a' })).join('\n'), /origin fork/);
  // Superseded: only a route, and it names the winner.
  assert.match(problems(routeData({ status: 'superseded' })).join('\n'), /superseded_by/);
  assert.deepEqual(problems(routeData({ status: 'superseded', superseded_by: 'route_2' })), []);
  const classic = { type: 'plan', title: 'Plan', status: 'superseded', target_asset: 'main_theorem' };
  assert.match(nodeProblems('plan', 'plan_1', classic, ROUTE_BODY).join('\n'), /only a route/);
  // The loop stamps reduction_digest; a stamp with no reduction is a broken file.
  assert.match(problems(routeData({ reduction_digest: 'abc' })).join('\n'), /reduction_digest without/);
});

test('route state comes from the plan and its lemmas', () => {
  const body = (reduction = '') => ROUTE_BODY + (reduction ? `\n## Reduction\n\n${reduction}\n` : '');
  const plan = (extra = {}, reduction = '') => ({ id: 'route_1', data: routeData(extra), content: body(reduction) });
  const open = () => ({ settled: false });
  assert.equal(routes.routeInfo(plan(), open).state, 'live');
  assert.equal(routes.routeInfo(plan(), open).reduction, 'none');
  const text = 'Assume lemma_a and lemma_b; then the statement follows.';
  const digest = routes.reductionDigest(body(text));
  assert.equal(routes.routeInfo(plan({ reduction_digest: digest }, text), open).reduction, 'written');
  const verified = plan({ reduction_digest: digest, reduction_verified_digest: digest }, text);
  assert.equal(routes.routeInfo(verified, open).state, 'reduced');
  // An edit after the stamp voids it: the reduction must be reported (and checked) again.
  assert.equal(routes.routeInfo({ ...verified, content: body(`${text} Edited.`) }, open).reduction, 'none');
  assert.equal(routes.routeInfo(plan({ status: 'failed' }), open).reduction, 'failed');
  assert.equal(routes.routeInfo(plan({ status: 'failed' }), open).state, 'failed');
  assert.equal(routes.routeInfo(plan({ status: 'succeeded' }), open).state, 'won');
  const superseded = routes.routeInfo(plan({ status: 'superseded', superseded_by: 'route_2' }), open);
  assert.equal(superseded.state, 'superseded');
  assert.equal(superseded.supersededBy, 'route_2');
  // Lemmas: one refuted kills the route, one parked suspends it, settled ones count.
  const dead = routes.routeInfo(plan(), (id) => ({ settled: false, refuted: id === 'lemma_b' }));
  assert.deepEqual([dead.state, dead.death], ['dead', { kind: 'refuted', lemma: 'lemma_b' }]);
  assert.equal(routes.routeInfo(plan(), (id) => ({ settled: false, inactive: id === 'lemma_a' })).death.kind, 'inactive');
  const suspended = routes.routeInfo(plan(), (id) => ({ settled: false, parked: id === 'lemma_a' }));
  assert.deepEqual([suspended.state, suspended.suspendedBy], ['suspended', ['lemma_a']]);
  assert.equal(routes.routeInfo(plan(), (id) => ({ settled: id === 'lemma_a' })).settledLemmas, 1);
  // A fork names its origin.
  assert.equal(routes.routeInfo(plan({ origin: 'fork', forked_from: 'lemma_a' }), open).forkedFrom, 'lemma_a');
});

/** A small AND-OR graph: assets with deps and routes, by hand. */
function graph({ settled = [], dead = [], deps = {}, routeList = [], leaf = {} }) {
  return {
    settled: (id) => settled.includes(id),
    dead: (id) => dead.includes(id),
    deps: (id) => (deps[id] ?? []).filter((dep) => !settled.includes(dep)),
    routes: (id) => routeList.filter((route) => route.target === id),
    leafCost: (id) => leaf[id] ?? 1,
  };
}
const route = (planId, target, lemmas, extra = {}) => ({ planId, target, title: planId, origin: 'agent', lemmas, state: 'live', reduction: 'none', settledLemmas: 0, ...extra });

test('proof numbers: the cheapest route counts, shared and settled lemmas are cheap, cycles are never cheap', () => {
  const r1 = route('r1', 'T', ['A', 'B']);
  const r2 = route('r2', 'T', ['B', 'X']);
  const g = graph({ settled: ['X'], routeList: [r1, r2] });
  const numbers = new routes.ProofNumbers(g);
  assert.equal(numbers.ofRoute(r1), 3, 'reduction + two open lemmas');
  assert.equal(numbers.ofRoute(r2), 2, 'X is settled');
  assert.equal(numbers.ofAsset('T'), 2);
  assert.equal(new routes.ProofNumbers(graph({ settled: ['X'], routeList: [r1, { ...r2, reduction: 'verified' }] })).ofAsset('T'), 1);
  // Unsettled depends_on add to every route.
  assert.equal(new routes.ProofNumbers(graph({ settled: ['X'], deps: { T: ['D'] }, routeList: [r1, r2] })).ofAsset('T'), 3);
  // A dead lemma makes its route useless; a route that rests on its own target too.
  assert.equal(new routes.ProofNumbers(graph({ dead: ['B'], routeList: [r1] })).ofAsset('T'), Infinity);
  const loop = [route('ra', 'A', ['B']), route('rb', 'B', ['A'])];
  assert.equal(new routes.ProofNumbers(graph({ routeList: loop })).ofAsset('A'), Infinity);
  assert.equal(new routes.ProofNumbers(graph({ routeList: [...loop, route('rb2', 'B', [])] })).ofAsset('A'), 2, 'another route out of the cycle');
  // No active route: the leaf cost (classic plans, or a new round).
  assert.equal(new routes.ProofNumbers(graph({ routeList: [{ ...r1, state: 'failed' }], leaf: { T: 4 } })).ofAsset('T'), 4);
});

test('the scheduler: depends_on first, then the cheapest route, its reduction first, shared lemmas next, commit when complete', () => {
  const always = () => true;
  const r1 = route('r1', 'T', ['A', 'S']);
  const r2 = route('r2', 'T', ['S', 'B', 'C']);
  // Trunk dependency first.
  assert.deepEqual(routes.mostProvingStep('T', graph({ deps: { T: ['D'] }, routeList: [r1, r2] }), always), { kind: 'asset', id: 'D' });
  // Then the reduction of the cheapest route.
  assert.deepEqual(routes.mostProvingStep('T', graph({ routeList: [r1, r2] }), always), { kind: 'reduce', planId: 'r1', target: 'T' });
  assert.deepEqual(routes.mostProvingStep('T', graph({ routeList: [{ ...r1, reduction: 'written' }, r2] }), always), { kind: 'verify_reduction', planId: 'r1', target: 'T' });
  // With the reduction verified, the lemma both routes share comes first.
  const reduced = { ...r1, reduction: 'verified', state: 'reduced' };
  assert.deepEqual(routes.mostProvingStep('T', graph({ routeList: [reduced, { ...r2, reduction: 'verified', state: 'reduced' }] }), always), { kind: 'asset', id: 'S' });
  // A lemma that cannot be worked on now is skipped for the next.
  assert.deepEqual(routes.mostProvingStep('T', graph({ routeList: [reduced, r2] }), (id) => id !== 'S'), { kind: 'asset', id: 'A' });
  // Complete: commit.
  assert.deepEqual(routes.mostProvingStep('T', graph({ settled: ['A', 'S'], routeList: [reduced, r2] }), always), { kind: 'commit', planId: 'r1', target: 'T' });
  // No route at all: the result itself (the loop decides: a round of routes or classic plans).
  assert.deepEqual(routes.mostProvingStep('T', graph({}), always), { kind: 'asset', id: 'T' });
  assert.equal(routes.mostProvingStep('T', graph({ settled: ['T'] }), always), undefined);
  // A lemma with its own routes is descended into.
  const lemmaRoute = route('rs', 'S', ['E']);
  assert.deepEqual(routes.mostProvingStep('T', graph({ settled: ['A'], routeList: [reduced, lemmaRoute] }), always), { kind: 'reduce', planId: 'rs', target: 'S' });
  // Without that, the cheaper lemma A (no routes, cost 1) comes before S (a route of cost 2).
  assert.deepEqual(routes.mostProvingStep('T', graph({ routeList: [reduced, lemmaRoute] }), always), { kind: 'asset', id: 'A' });
});

test('the beam keeps the cheapest routes active and freezes the rest; researcher routes win ties', () => {
  const list = [route('r1', 'T', ['A', 'B']), route('r2', 'T', ['A']), route('r3', 'T', ['C'], { origin: 'researcher' }), route('o1', 'U', [])];
  const cost = (r) => r.lemmas.length;
  const beamed = routes.applyBeam(list, 2, cost);
  assert.deepEqual(beamed.map((r) => [r.planId, r.state]), [['r1', 'frozen'], ['r2', 'live'], ['r3', 'live'], ['o1', 'live']]);
  assert.deepEqual(routes.applyBeam(list, 1, cost).filter((r) => r.state !== 'frozen').map((r) => r.planId), ['r3', 'o1']);
  assert.deepEqual(routes.applyBeam(list, 5, cost).map((r) => r.state), ['live', 'live', 'live', 'live']);
});

test('the route map digest changes with a route, a lemma statement, or the goal, not with a reduction', () => {
  const lemma = (statement) => matter.stringify(`\n## Statement\n\n${statement}\n`, { type: 'lemma', title: 'Lemma', status: 'draft', depends_on: [] });
  const goal = lemma('The main claim.');
  const raws = { lemma_a: lemma('A holds.'), lemma_b: lemma('B holds.') };
  const plans = [{ id: 'route_1', data: routeData(), content: ROUTE_BODY }];
  const base = routes.routeMapDigest(goal, plans, (id) => raws[id]);
  assert.equal(routes.routeMapDigest(goal, [{ ...plans[0], content: `${ROUTE_BODY}\n## Reduction\n\nSome text.\n` }], (id) => raws[id]), base);
  assert.notEqual(routes.routeMapDigest(goal, plans, (id) => ({ ...raws, lemma_b: lemma('B holds strictly.') })[id]), base);
  assert.notEqual(routes.routeMapDigest(lemma('Another claim.'), plans, (id) => raws[id]), base);
  const second = { id: 'route_2', data: routeData({ route_lemmas: ['lemma_a'] }), content: ROUTE_BODY };
  assert.notEqual(routes.routeMapDigest(goal, [...plans, second], (id) => raws[id]), base);
  // A route no longer pending (dropped, failed) leaves the map.
  assert.equal(routes.routeMapDigest(goal, [...plans, { ...second, data: { ...second.data, status: 'abandoned' } }], (id) => raws[id]), base);
});
