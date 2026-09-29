---
name: extract-research-nodes
description: Extract draft research nodes - theorem-like results, examples, standard definitions, and project-specific remarks - from an imported paper transcription, research notes, or existing assets. Use when turning source text into assets or definitions; use import-math-paper first for a new PDF.
---

# Extract research nodes

Scope the request: `results` (theorems, lemmas, propositions, examples, constructions), `definitions`, or `all`. Read `.research-assistant.json` for folder paths, then the relevant transcription, notes, or asset bodies. Check the source PDF for any ambiguous statement, formula, numbering, or attribution when it is available. Search existing assets and definitions before creating a node, and reuse a matching one.

## Results

Create one Markdown asset per useful result under the configured assets folder with a descriptive snake_case filename ID, `type` (theorem, lemma, proposition, example, construction, or remark), a plain `title`, and `status: draft`. Record provenance in `source`: `kind: paper` with the paper slug as `paper_id` and the exact page or theorem number as `location`, `textbook` in the same way (a cited result: the loop checks the citation instead of proving it), `note` for an informal source such as a talk or lecture notes (it will still be proved here), or `original` for content produced in this project. Include the statement, known `depends_on` asset IDs, `uses_definitions` IDs, and tags. Do not invent proof details or dependencies.

## Definitions and remarks

Extract a `type: definition` node only for a concept with a commonly used mathematical meaning, in its conventional scope, titled `Definition (concept)`, with `depends_on` listing definition IDs and a body giving the defining statement and the notation it introduces. A condition, assumption, or specialized use introduced only for this project is a separate draft `type: remark` asset, even when the source calls it a definition; split a mixed passage into the standard definition and a remark. Link the remark to the definitions it uses (`uses_definitions`) and relate it to the assets it affects with relative Markdown links, adding `depends_on` only for a real mathematical dependency. If conventional usage is uncertain, report it for researcher review instead of presenting the text as standard.

Add `uses_definitions` to an existing asset only when concept and definition match. A verified link alone does not reset approval; report each such link for review. Any material change to a statement or proof leaves the node `draft`.

## Finish

Run `research-maintenance validate` and fix every problem, then `research-maintenance links --preview` and `--apply` for the new or changed bodies (see that skill for review of missed mentions). Run `check-notation` on new or materially revised assets. If the researcher asked for candidates rather than files, return the same content as Markdown blocks with YAML frontmatter. Flag uncertain readings and source passages that still need checking.
