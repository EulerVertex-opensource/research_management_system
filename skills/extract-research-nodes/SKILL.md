---
name: extract-research-nodes
description: Extract draft research nodes - theorem-like results, examples, standard definitions, and project-specific remarks - from an imported paper transcription, research notes, or existing assets, into the project or into the library of known results. Use when turning source text into assets or definitions, or when importing earlier theorems or a useful paper's results into the library; use import-math-paper first for a new PDF.
---

# Extract research nodes

Scope the request: `results` (theorems, lemmas, propositions, examples, constructions), `definitions`, or `all`, and the target: the **project** (results this research will prove or use) or the **library** (known results: the researcher's earlier theorems, results of a paper they know is useful). Read `.research-assistant.json` for folder paths, then the relevant transcription, notes, or asset bodies. Check the source PDF for any ambiguous statement, formula, numbering, or attribution when it is available. Search existing assets, definitions, and the library (`research-loop library search <words>` when the loop is installed) before creating a node, and reuse a matching one.

## Results

Create one Markdown asset per useful result under the configured assets folder with a descriptive snake_case filename ID, `type` (theorem, lemma, proposition, example, construction, or remark), a plain `title`, and `status: draft`. Record provenance in `source`: `kind: paper` with the paper slug as `paper_id` and the exact page or theorem number as `location`, `textbook` in the same way (a cited result: the loop checks the citation instead of proving it), `note` for an informal source such as a talk or lecture notes (it will still be proved here), or `original` for content produced in this project. Include the statement, known `depends_on` asset IDs, `uses_definitions` IDs, and tags. Do not invent proof details or dependencies.

## Definitions and remarks

Extract a `type: definition` node only for a concept with a commonly used mathematical meaning, in its conventional scope, titled `Definition (concept)`, with `depends_on` listing definition IDs and a body giving the defining statement and the notation it introduces. A condition, assumption, or specialized use introduced only for this project is a separate draft `type: remark` asset, even when the source calls it a definition; split a mixed passage into the standard definition and a remark. Link the remark to the definitions it uses (`uses_definitions`) and relate it to the assets it affects with relative Markdown links, adding `depends_on` only for a real mathematical dependency. If conventional usage is uncertain, report it for researcher review instead of presenting the text as standard.

Add `uses_definitions` to an existing asset only when concept and definition match. A verified link alone does not reset approval; report each such link for review. Any material change to a statement or proof leaves the node `draft`.

## Into the library

Use the library when the researcher asks to import known results, or names a collection. The library lives under the configured research root as `library/<collection>/assets/` and `library/<collection>/definitions/`, one collection per source (for example `my_thesis`, `smith2021_rigidity`, `alice_notes`; lowercase snake_case). The rules above apply, with these differences:

- Every ID starts with `lib_` (`lib_compact_embedding`, `lib_sobolev_space`), is unique across the whole project, and the file goes in the collection's `assets/` or `definitions/` folder.
- A library node's `depends_on` and `uses_definitions` name only library IDs, in any collection; never a project node.
- `source` says where the result is established: `paper` or `textbook` with `paper_id` and exact `location` for a published result (index the paper in the paper index and bibliography as for any citation), `original` for the researcher's own earlier work, naming the thesis, preprint, or project in the body. Keep the proof or a proof sketch under `## Proof` when the source gives one; otherwise give the statement only.
- New files are `status: draft`. Existing library files may be edited (fix a typo, sharpen a statement, add a proof, add links); git keeps the history. Editing an approved one returns it to draft, and a changed statement also invalidates approved results that depend on it, so say which approved results you touched. Keep the ID when the result is the same; a genuinely different result gets a new `lib_` ID. For a project-specific variant that should be proved here, `research-loop library promote <lib_id> [--as <id>]` copies it into the project as a draft with `derived_from`.
- Optionally create `collection.md` in a new collection with a title and one paragraph on the source (who, what, where to find it).

The researcher approves library results once in VS Code; the research loop then uses them as known and never re-proves them. After a batch, list the new IDs per collection so the researcher can review them together.

## Finish

Run `research-maintenance validate` and fix every problem, then `research-maintenance links --preview` and `--apply` for the new or changed bodies (see that skill for review of missed mentions). Run `check-notation` on new or materially revised assets. If the researcher asked for candidates rather than files, return the same content as Markdown blocks with YAML frontmatter. Flag uncertain readings and source passages that still need checking.
