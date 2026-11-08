---
name: verify-node
description: Independently check a definition, or a result taken from a source (a citation or a library result), before auto mode approves it, and report a confirmed or rejected verdict. Used by the research loop's verify_node stage.
---

# Check a definition or a cited result

Auto mode (and autonomous mode) approves a definition or a result taken from a source only after this check. Nobody else reads it before the loop builds on it, so check as the researcher would. Input: the context pack from `research-loop next`. For anything else run `research-loop show <id> [--section Heading]`. Change no file: the verdict is your report.

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

## Verdict

- `report confirmed --summary "<what you checked, in a line or two>"`.
- `report rejected --summary "<the first problem: what is wrong, where, and what would fix it>"`. The node then waits for the researcher with your verdict; the loop does not check that version again.

Do not read remarks; this is a checking stage, and the hooks refuse it.
