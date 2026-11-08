---
name: verify-node
description: Independently check a definition, a result taken from a source (a citation or a library result), or a written proof as it stands (the researcher's manuscript, say), and give a confirmed or rejected verdict. Used by the research loop's verify_node stage and by research-loop check right after extraction.
---

# Check a definition, a cited result, or a written proof

Auto mode (and autonomous mode) approves a definition, a result taken from a source, or a proof no plan of the loop wrote only after this check; without auto mode the researcher reviews with your verdict. Check as the researcher would. You come here two ways:

- The loop's `verify_node` stage: the pack is the one `research-loop next` names; the verdict is your `report`.
- `research-loop check` after an extraction: the pack and the exact `check verdict` command are in your instruction.

For anything else run `research-loop show <id> [--section Heading]`. Change no file.

## A definition

- **Well formed.** Every symbol and term in it is defined: by itself, by a definition it lists in `depends_on`, or as standard background the project states. Nothing is circular. The notation it introduces is used consistently.
- **Says what its users need.** Read the statements in the pack that use it. Each must make sense with this definition and mean what its title says (the right objects, the right quantifiers, the hypotheses in the right place).
- **Does not change the problem.** This is the check that matters most. A definition must not make a goal trivial, vacuous, or a different problem: a class that is empty or contains only trivial objects, a condition that already contains the conclusion, a notion weaker or stronger than the goals in `project.md` mean.
- **Matches its source**, when it cites one (`source.paper_id` and `location`): read the location and compare.
- An assumption (`definition_kind: assumption`) is checked for consistency and for not assuming the conclusion; a convention, for being notation only.

## A result taken from a source

- Read the cited location: `research-loop show <paper_slug>` for the outline, then `--section`. A library collection names its paper in `collection.md`; a result of the researcher's own earlier work names it in the body.
- Compare word for word: every hypothesis kept (a dropped hypothesis is the usual error), quantifiers and their order, constants and exponents, the conclusion, the theorem number or page in `location`.
- The definitions it uses must mean what the source means by those words.
- If the source cannot be read (no transcription, the location does not exist), report `question --question "..."`.

## A proof as written

- The verify-proof skill's standard applies: check the `## Proof` against the statement step by step, as a referee would. Every step follows; every hypothesis of a dependency or cited result holds where it is used; nothing is assumed that the statement does not give; every case is covered.
- A step the author calls clear is still checked. A gap that a short argument would close is still a gap: name it, and say the argument.
- Dependencies are black boxes: use their statements in the pack, not their proofs.
- On a re-check (the pack says which statements changed), check every step that uses them against their current text.

## Verdict

- In the loop: `report confirmed --summary "<what you checked, in a line or two>"`, or `report rejected --summary "<the first problem: what is wrong, where, and what would fix it>"`.
- After an extraction: the same two verdicts with `research-loop check verdict <id> confirmed|rejected --summary "..."`.
- A rejected node waits for the researcher with your verdict, and that version is not checked again. A rejected proof is kept: it is the researcher's to revise.

Do not read remarks; this is a checking stage, and the hooks refuse it.
