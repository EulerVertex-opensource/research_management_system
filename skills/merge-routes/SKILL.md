---
name: merge-routes
description: Merge a round of parallel routes to a research result - find lemmas that state the same thing, imply one another, or only look alike - and record each finding with the research-loop route commands. Used by the research loop's route_merge stage.
---

# Merge routes

Routes planned side by side often need the same lemma under different names, or one needs a stronger form of another's. Merging finds that, so a lemma is proved once and serves every route that needs it. You judge; the loop changes the files.

Input: the pack lists the target, every open route to it (this round's first) with its `## Route`, the statement of every route lemma, and the project's node index. For anything else run `research-loop show <id>`; for the library, `research-loop library search <words>` with a lemma's key terms.

Compare each lemma of this round with every other route lemma, with the project's results, and with the library:

- **Same statement** (the same claim up to notation and harmless rewording, with the same hypotheses): `research-loop route merge <dup> --into <keep>`. Keep the one already approved or proved, else a library or project result, else the older lemma. Only a draft lemma that nothing but routes uses can be merged away; the command says when it cannot.
- **One implies the other** (stronger conclusion, or weaker hypotheses): `research-loop route imply <stronger> <weaker> [--note "why"]`. The weaker lemma gets a route of its own from the stronger one, so proving either serves the routes that need the weaker. Two lemmas that imply each other are the same: merge them.
- **Alike but different** (close enough that someone would merge them by mistake): `research-loop route distinct <a> <b> --note "<the difference that matters>"`.

Be strict. A merge or implication you are not sure of is a proof step nobody checks: when in doubt, record `distinct` with what you could not settle. Do not edit any file yourself, do not change a statement, and do not drop routes (only the researcher does).

Then `research-loop report complete --summary "<what was merged or linked, in words; or that nothing was>"`, written for the researcher: name lemmas by what they say, not by ID.
