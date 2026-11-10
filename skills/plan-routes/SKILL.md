---
name: plan-routes
description: Plan one route to a draft research result for one slot of a round of parallel routes - the lemmas to prove first and the reduction from them - as a route plan with draft lemma assets. Used by the research loop's route stage.
---

# Plan a route

A route proves a result from a few lemmas: the lemmas are proved on their own (search, plan, proof, as any result), and a short **reduction** shows that the result follows from them. Several routes to one result are planned side by side, each by its own worker, so the loop can work on them in parallel instead of committing to one. You plan one route, for your slot.

Input: your slot's pack (`.research-assistant-loop/context/route-<slot>.md`): the target statement, its dependencies and definitions, the failed attempts so far, the open routes to the target (plan a different one), library analogues, the idea guide, the node index, and your slot's direction. A slot of origin `researcher` carries the researcher's own route as an idea: work out *their* route, faithfully; do not swap in your own. A slot of a fork names the proved result every route of the round starts from. Read only the pack; for anything else run `research-loop show <id> [--section Heading]`.

## The route

- Choose the lemmas so that each is a clean, checkable statement with its own hypotheses, and so that the reduction from them to the target is short. One to three lemmas is typical; a route with no lemma (`route_lemmas: []`) is a direct proof.
- Reuse before you create. A lemma that states a result already in the project or the library uses that ID (`research-loop library search <words>`; the node index lists the project's). An approved or proved result costs the route nothing. A fork lists its starting result in `route_lemmas` and in `forked_from`.
- A new lemma is a draft asset in the assets folder: `type: lemma` (or proposition), `title`, `status: draft`, `source.kind: original`, `depends_on`, `uses_definitions`, and a precise `## Statement` with every hypothesis. Never a conjecture, never a result that rests on the target.
- Do not prove anything, and do not search for counterexamples: the loop does both for each lemma afterwards.

## The file

`<plans>/route_<target>_r<round>_s<slot>_<slug>.md`, exactly as the instruction names it, with frontmatter `type: plan`, `status: pending`, `target_asset`, `route_lemmas`, `route_title` (a few words the researcher reads, e.g. "via energy decay"), `origin` as your slot says (`researcher`, `agent`, or `fork`), `forked_from` for a fork, and `inspired_by` (your slot's idea, and any other idea you draw on). Body:

- `## Goal` starting with `Target: [<target>](../assets/<target>.md)`;
- `## Route`: one line per lemma, what it gives the reduction (`- energy_bound: controls the nonlinear term in step 2`);
- `## Plan`: the reduction as an ordered checklist `1. [ ] ...`, each step a checkable claim that uses the lemmas and dependencies by their statements;
- `## Verification`: how the steps give the exact statement;
- with failed attempts in the pack, `## Difference from failed plans`: one bullet per failed plan ID, naming what this route does differently.

Never write `route_round`, `reduction_digest`, or any other field the loop stamps. No genuinely different route in sight for your slot: write nothing and say so in your three lines back; the driver reports `none` for the round only when no slot wrote a route.
