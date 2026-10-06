const matter = require('gray-matter');

/** Object-search records as a worker writes them, shared by the loop tests. */

const candidate = (target = 'main_theorem', status = 'failed', checks = status === 'failed' ? { H1: 'pass', NOT: 'fail' } : { H1: 'pass', NOT: 'pass' }) => matter.stringify(
  `\n## Object\n\nn = 0.\n\n## Checks\n\n### H1\n\n0 is a natural number.\n\n### NOT\n\n${status === 'failed' ? '0 = 0, so the conclusion holds.' : 'The conclusion fails for 0.'}\n${status === 'failed' ? '\n## Failure\n\nNOT fails: 0 = 0.\n' : ''}`,
  { type: 'candidate', title: 'Zero', status, target_asset: target, checks },
);

const roundRecord = (target = 'main_theorem', obstruction = 'Equality is reflexive for every n.') => matter.stringify(
  `\n## Obstructions\n\n- ${obstruction}\n\n## Limitations\n\nOnly n = 0 was tried.\n`,
  { type: 'search_round', title: `Search round on ${target}`, target_asset: target },
);

let serial = 0;

/** Write one worker's result for the current round: a candidate per slot (failed unless given), plus the round record with a single slot. */
function writeRound(f, { target = 'main_theorem', status = 'failed', record } = {}) {
  const search = f.core.current.current.search;
  const slug = `t${++serial}`;
  for (const slot of search.slots) f.map.set(`research/candidates/cand_${target}_r${search.round}_s${slot.slot}_${slug}.md`, candidate(target, status));
  if (record ?? search.slots.length === 1) f.map.set(`research/checks/search_${target}_r${search.round}_${slug}.md`, roundRecord(target));
  return slug;
}

/** A refute search that finds nothing: one round with one worker, then plan. */
async function searchNothing(f, target = 'main_theorem') {
  writeRound(f, { target });
  return f.core.report({ outcome: 'searched', summary: 'No counterexample' });
}

module.exports = { candidate, roundRecord, writeRound, searchNothing };
