/**
 * Which conjectures to take up first. Pure: the loop (reassessments, autonomous exploration,
 * the recommendations at the end) and the dashboard rank them the same way. The order comes from
 * how a conjecture relates to the goals, never from a score the agent invents:
 *
 *   0  serves an open goal or a result set aside on the way to one (a weaker form, another route)
 *   1  strengthens or generalizes a result already proved
 *   2  of independent interest
 *
 * Within a rank the researcher's `priority` decides first, then whether the researcher raised it
 * (a conjecture idea of theirs, e.g. from the teaching chat), then whether its statement is
 * agreed, then whether a counterexample search came up empty.
 */

export interface ConjectureInput {
  id: string;
  status: string;
  /** Results it would unblock or strengthen (the conjecture's `serves`). */
  serves: string[];
  priority?: 'high' | 'low';
  /** The researcher raised it: it resolved a conjecture idea of theirs. */
  researcher?: boolean;
  /** A counterexample search found nothing for its current statement. */
  falsified?: boolean;
  /** An accepted counterexample refutes it. */
  refuted?: boolean;
}

export interface ConjectureContext {
  /** Open required results and the results set aside on their paths. */
  open: ReadonlySet<string>;
  /** Results proved (approved with a matching record). */
  proved: ReadonlySet<string>;
}

export type ConjectureRank = 0 | 1 | 2;
export interface RankedConjecture { id: string; rank: ConjectureRank; serves: string[]; reason: string; agreed: boolean; falsified: boolean }

export const RANK_TEXT: Record<ConjectureRank, string> = {
  0: 'serves an open goal',
  1: 'strengthens a proved result',
  2: 'of independent interest',
};

/** Active, unrefuted conjectures, best first. */
export function rankConjectures(conjectures: ConjectureInput[], context: ConjectureContext): RankedConjecture[] {
  const ranked = conjectures
    .filter((item) => !item.refuted && (item.status === 'draft' || item.status === 'approved'))
    .map((item) => {
      const open = item.serves.filter((id) => context.open.has(id));
      const proved = item.serves.filter((id) => context.proved.has(id));
      const rank: ConjectureRank = open.length ? 0 : proved.length ? 1 : 2;
      const named = rank === 0 ? open : rank === 1 ? proved : [];
      const reason = `${RANK_TEXT[rank]}${named.length ? ` (${named.join(', ')})` : ''}${item.researcher ? '; raised by the researcher' : ''}`;
      return { item, entry: { id: item.id, rank, serves: item.serves, reason, agreed: item.status === 'approved', falsified: Boolean(item.falsified) } };
    });
  const weight = (item: ConjectureInput) => (item.priority === 'high' ? 0 : item.priority === 'low' ? 2 : 1);
  ranked.sort((a, b) => a.entry.rank - b.entry.rank
    || weight(a.item) - weight(b.item)
    || Number(Boolean(b.item.researcher)) - Number(Boolean(a.item.researcher))
    || Number(b.entry.agreed) - Number(a.entry.agreed)
    || Number(b.entry.falsified) - Number(a.entry.falsified)
    || a.entry.id.localeCompare(b.entry.id));
  return ranked.map(({ entry }) => entry);
}

/** One line per conjecture for an instruction or a handoff. */
export function describeConjectures(ranked: RankedConjecture[], limit: number): string {
  const lines = ranked.slice(0, limit).map((item) => `- ${item.id}: ${item.reason}; ${item.agreed ? 'statement agreed' : item.falsified ? 'no counterexample found, not yet agreed' : 'not yet checked'}`);
  if (ranked.length > limit) lines.push(`- and ${ranked.length - limit} more`);
  return lines.join('\n');
}
