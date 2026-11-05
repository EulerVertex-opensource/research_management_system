---
name: search-object
description: Search for a concrete object in rounds of parallel workers. Refute mode looks for a counterexample to a draft asset before it is proved; construct mode looks for an object with every property of a construction's approved specification. A summary turns a round's failures into obstructions; an independent check verifies a survivor. Used by the research loop's search, search_summary, verify_counterexample, and verify_construction stages.
---

# Search for an object

Input: the pack the driver gives you. A search worker gets its own `search-<slot>.md` with:
- the target statement, its direct dependencies, and its definitions;
- the **search board**: obstructions, near-misses, directions and ideas already tried (with what came of each), and open observations;
- your slot, round, and **direction**.

Read only the pack; for anything else run `research-loop show <id> [--section Heading]`. Do not read the target's `## Proof`, other slots' work, or other candidate files unless the pack names one.

## Search (refute mode)

You look for a counterexample: an object that satisfies every hypothesis of the target and violates its conclusion.

1. List the target's hypotheses as checks `H1`, `H2`, … in order. The last check is `NOT`: the conclusion fails for the object.
2. Stay in your direction (`references/directions.md`). Use the board: do not repeat a near-miss, an idea tried, or a family an obstruction already rules out. Changing only a parameter, a constant, or a scale of a failed family is a repeat unless you say why the failure no longer applies.
3. For each candidate, check in order and stop at the first failing check. Mark that check `fail` and every later check `unknown`. Compute explicitly.
4. Write each candidate as a new file `<candidates>/cand_<asset>_r<round>_s<slot>_<slug>.md`, at most the number the stage instruction allows.
   - Frontmatter: `type: candidate`, `title`, `status: failed` (a check failed) or `survived` (every check passed), `target_asset`, and `checks: {H1: pass, H2: fail, NOT: unknown}`.
   - Body:
     - `## Object`: the object, precisely enough to recompute.
     - `## Checks`: one `### H1`, `### H2`, …, `### NOT` per check, with the argument or calculation.
     - `## Failure`: one line naming the first failing check and why. Only for a failed candidate.
5. Worked an object out far enough to see a check fail? Write it as a failed candidate with `## Failure`, even a promising ansatz: that is how later rounds learn it fails. Found nothing plausible? Write no candidate.
   - Record with `record_idea` (kind `test_case`, origin `agent`) only an object you could not check yet, and say in its body what you did check.
   - Never record one the board shows failing, or a variant of its family: the loop assigns open test cases to later rounds.
6. If the instruction says you are the only worker, also write the round record (see Summarize).

Reply in three lines at most: the candidates you wrote and their status, and the key reason.

The loop stamps the round, slot, direction, and statement on your files; do not write those fields. Never write assets or edit existing files. A survivor is not a confirmed counterexample: the loop copies it into a draft example, and an independent worker verifies it.

A failed proof attempt or a doubt is not a candidate. Record it with `record_idea` (kind `risk`).

## Search (construct mode)

You look for an object with every property `P1`, `P2`, … of the target's specification (its statement). The researcher approved that list; never change it.

- Your checks are exactly the specification's properties, in its order. No `NOT` check.
- Otherwise work as in refute mode: stay in your direction, use the board, check fail-fast, and write the same candidate files. A survivor passes every property.
- `repair_near_miss`: the pack holds the near-miss. Change it so the failed property holds, and recheck every property, since a repair can break one that passed.
- `nonexistence`: write no candidate. Try to prove no object has all the properties, starting from the board's obstructions. Record what you establish with `record_idea` (kind `observation`, `--asset <target>`). A complete impossibility proof goes to the researcher this way; it never becomes an asset here.

## Summarize

Input: the board and one line per candidate of the round.

Write one round record `<checks>/search_<asset>_r<round>_<slug>.md`:
- Frontmatter: `type: search_round`, `title`, `target_asset`.
- `## Obstructions`: one bullet per reason a whole family fails, stated generally (for example "every abelian G fails H3: the commutator vanishes"), not one bullet per candidate.
- `## Limitations`: what no worker covered this round.

An obstruction that reads like a step of a proof of the target is worth a `record_idea` (kind `approach`) naming the step. Change nothing else.

## Verify

Reread the statement and the example from the pack, not from memory or the search reasoning. Recheck every assumption and every calculation step, and try to break the example.

Add `## Verdict` to the example: `confirmed` or `rejected`, with the reason.
- **Rejected:** set the example `status: archived`. The loop keeps the candidate on the board as a near-miss and continues the search.
- **Confirmed:** leave it `draft`. The loop asks the researcher to confirm it and parks the asset meanwhile.

Never edit the refuted asset. Report `confirmed` or `rejected`. Never set `status: approved`.

## Verify a construction

Input: the specification and the survivor's `## Object`, but not its checks. Check every property yourself, from the specification.

Add `## Verdict` to the candidate file:
- the first line is `confirmed` or `rejected`;
- then one `### P1`, `### P2`, … per property, each with the complete argument.

On `confirmed`, the loop writes the object into the asset as `## Construction` and your arguments as its `## Proof`; the researcher then approves it. So write them as a proof a reader can check. On `rejected`, say which property fails and why; the loop keeps the candidate on the board as a near-miss and continues the search.

Leave the candidate's status and every other section unchanged, and never edit the asset. Report `confirmed` or `rejected`.
