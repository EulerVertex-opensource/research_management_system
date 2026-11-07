---
name: extract-research-nodes
description: Extract draft research nodes - theorem-like results, examples, definitions (every concept a kept result uses, standard or newly introduced), assumptions, conventions, and remarks - from an imported paper transcription, research notes, or existing assets, into the project or into the library of known results. Use when turning source text into assets or definitions, when the researcher asks to organize, sort, or ingest research materials, or when importing earlier theorems or a useful paper's results into the library; use import-math-paper first for a new PDF.
---

# Extract research nodes

Scope the request: `results` (theorems, lemmas, propositions, examples, constructions), `definitions`, or `all`, and the target: the **project** (results this research will prove or use) or the **library** (known results: the researcher's earlier theorems, results of a paper they know is useful). Read `.research-assistant.json` for folder paths, then the relevant transcription, notes, or asset bodies. Check the source PDF for any ambiguous statement, formula, numbering, or attribution when it is available. Search existing assets, definitions, and the library (`research-loop library search <words>` when the loop is installed) before creating a node, and reuse a matching one.

## Organizing materials

When the researcher hands over a batch of materials to organize, sort each part to its one destination and extract it; do not invent another structure:

- A written manuscript: the main TeX document when it already holds the paper, or a Markdown draft of it. Its mathematics and its prose have different destinations, and organizing is not finished until both are filled, in this order:
  1. The manuscript is the researcher's finished work: extract all of it as written, `source.kind: original`. Every result becomes an asset with its statement and proof (under `## Proof`), and every definition it states, standard or newly introduced, becomes a definition node (Definitions, assumptions, and conventions). A proof's `\ref` or `\cite` to another result becomes a `depends_on` or a cited library or paper node, and a use of a defined term or notation becomes a `uses_definitions`, so the graph reproduces the manuscript's dependencies.
  2. Propose `project.md` text from the abstract and introduction, with the main theorems as `required_results`.
  3. The prose: `plan-manuscript` (scope adopt) splits the TeX into section files and writes briefs citing the new node IDs, then `draft-latex` wraps the passages that present them in blocks. A Markdown draft gets the outline and briefs only; `draft-latex` writes its TeX when the researcher asks.
  4. Finish below, then request approval of the extracted nodes (`request_approval`) so the researcher reviews them together.
- A paper PDF: `import-math-paper` (transcription in `papers/<slug>/`, PDF in the local source folder), then extract its useful results and definitions below.
- Notes, drafts, or TeX with mathematical content: results and definitions below; anything that is not yet a statement (an approach, a question, an observation) becomes an idea (`type: idea`, `status: draft`, `idea_kind`).
- Earlier work or known results the project will use, not prove: the library (below).
- Results of another Research Assistant project (its folder, an exported `.rpkg.json`, or its git URL): import it as a package (Packages, below); do not extract it by hand.
- The main problem, scope, or goals: propose the text for `project.md` to the researcher; do not overwrite it.

Each node is one file directly in its configured folder. Never create subfolders, new folders, or index, README, overview, or other folder notes: the dashboard and the loop read only the configured folders, so such files are lost, and the PreToolUse hook denies them. Group with `tags` and relate with `depends_on`, `uses_definitions`, and `related_assets`. Keep raw source files out of the research folders. Finish with a list of what went where.

## Results

Create one Markdown asset per useful result under the configured assets folder with a descriptive snake_case filename ID, `type` (theorem, lemma, proposition, example, construction, or conjecture for a statement the source believes but does not prove; a conjecture needs `## Motivation` and may list the results it would serve under `serves`), a plain `title`, and `status: draft`. Record provenance in `source`: `kind: paper` with the paper slug as `paper_id` and the exact page or theorem number as `location`, `textbook` in the same way (a cited result: the loop checks the citation instead of proving it), `note` for an informal source such as a talk or lecture notes (it will still be proved here), or `original` for content produced in this project. Include the statement, known `depends_on` asset IDs, `uses_definitions` IDs, and tags. A construction still to be found is a specification: its statement lists the required properties one per line as `- P1: ...`, `- P2: ...`, and the loop searches for an object with all of them once the researcher approves the list. A construction of a given object states the object instead. Do not invent proof details or dependencies.

## Definitions, assumptions, and conventions

Decide by use, not by whether a concept is standard. A concept becomes a `type: definition` node when a result being kept, or a required result in `project.md`, uses it in its statement or proof, whether it is standard or introduced by the source. This includes the conditions and hypotheses a source defines ("we say $f$ satisfies (H) if ..."): the results that assume them list them in `uses_definitions`, so a later change to the condition marks those results stale. In the researcher's own manuscript every result is kept, so every definition it states becomes a node, even one used only in an example or in the prose.

- Title it `Definition (concept)`, with a body giving the defining statement and the notation it introduces as the source writes them. `depends_on` lists the definitions it builds on. Every result whose statement or proof uses the term or its notation lists it in `uses_definitions`, with or without a `\ref`.
- A labelled list of hypotheses gives one node per label (`Definition (hypothesis H1)`, ...), so each result lists exactly the hypotheses it assumes.
- Reuse an existing definition node only when the meaning is the same. When a source uses the same word in a different sense, create a node with a qualified ID (`admissible_pair_smith2021`) and a title naming whose sense it is; never edit the existing node to fit.
- Skip a source's definitions that no kept result uses; they stay in its transcription.
- When unsure whether a kept result depends on a definition, extract it and flag it for researcher review: a missing node breaks the graph, while the researcher can drop an unneeded one.

Text that defines nothing but that results rely on is a definition node too, with `definition_kind`:

- `definition_kind: assumption`, titled `Assumption (...)`: a hypothesis a part of the source takes for granted ("from now on, $\Omega$ is bounded"). Every result in its scope lists it in `uses_definitions`, so a change to it marks them stale. A standing assumption for the whole project goes into `project.md` under Scope and Assumptions instead, so not every result has to list it.
- `definition_kind: convention`, titled `Convention (...)`: notation or a normalization with no mathematical content ("$C$ denotes a constant that may change from line to line"). The results whose statements depend on it list it in `uses_definitions`.

A source's remark is sorted by what it says:

- It claims something (a bound is sharp, a hypothesis can be dropped, a special case behaves differently): a `proposition`, `lemma`, or `example` asset, with its proof if the source gives one. Never leave a claim in prose that no node proves.
- It explains (the idea behind a proof, why a hypothesis is needed, how a result relates to another): a remark on the result it explains, `node .agents/skills/research-loop/scripts/research-loop.cjs remark add --target <id> --title "..." --body "..." --origin researcher` for the researcher's own manuscript, `--origin agent` otherwise. Remarks are annotations, not nodes: nothing depends on them.

Add `uses_definitions` to an existing asset only when concept and definition match. A verified link alone does not reset approval; report each such link for review. Any material change to a statement or proof leaves the node `draft`.

## Into the library

Use the library when the researcher asks to import known results, or names a collection. The library lives under the configured research root as `library/<collection>/assets/` and `library/<collection>/definitions/`, one collection per source (for example `my_thesis`, `smith2021_rigidity`, `alice_notes`; lowercase snake_case). The rules above apply, with these differences:

- Every ID starts with `lib_` (`lib_compact_embedding`, `lib_sobolev_space`), is unique across the whole project, and the file goes in the collection's `assets/` or `definitions/` folder.
- A library node's `depends_on` and `uses_definitions` name only library IDs, in any collection; never a project node.
- `source` says where the result is established: `paper` or `textbook` with `paper_id` and exact `location` for a published result (index the paper in the paper index and bibliography as for any citation), `original` for the researcher's own earlier work, naming the thesis, preprint, or project in the body. Keep the proof or a proof sketch under `## Proof` when the source gives one; otherwise give the statement only.
- New files are `status: draft`. Existing library files may be edited (fix a typo, sharpen a statement, add a proof, add links); git keeps the history. Editing an approved one returns it to draft, and a changed statement also invalidates approved results that depend on it, so say which approved results you touched. Keep the ID when the result is the same; a genuinely different result gets a new `lib_` ID. For a project-specific variant that should be proved here, `research-loop library promote <lib_id> [--as <id>]` copies it into the project as a draft with `derived_from`.
- Optionally create `collection.md` in a new collection with a title and one paragraph on the source (who, what, where to find it).

The researcher approves library results once in VS Code; the research loop then uses them as known and never re-proves them. After a batch, list the new IDs per collection so the researcher can review them together.

## Packages

Another Research Assistant project's approved results come in as a package, not by extraction: they keep their dependencies, citations, and the upstream approval record, and a later version can be brought in with a precise list of what changed. The commands preview by default and write only with `--apply`:

```bash
node .agents/skills/research-loop/scripts/research-loop.cjs package import <folder | file.rpkg.json | git URL[#branch-or-tag]> [--as <alias>]
node .agents/skills/research-loop/scripts/research-loop.cjs package update <alias> [<source>] [--ref <tag>]
node .agents/skills/research-loop/scripts/research-loop.cjs package list
```

- Run the preview first and tell the researcher what it would write: the results (`lib_<alias>_<id>`), the bibliography changes (added, reused, or renamed keys), conflicts, and warnings. Apply only after they agree. A short alias keeps the IDs readable; choose it with `--as`.
- Never import, update, or remove a package while a loop stage is in progress; ask the researcher to pause the loop.
- An imported collection is read-only: never edit its files (the hook refuses). To change a result, `library promote <lib_id>` copies it into the project as a draft.
- Accepting a package is the researcher's decision, in the dashboard (Library or Needs you) or `package approve <alias> --interactive` in their own terminal. Never run `package approve`; tell the researcher it waits.
- After an update, report the version change and the approvals it affected (the update output lists them).
- Exporting this project (`package export`) is the researcher's action, usually from the dashboard; it needs a package name and this work's own BibTeX entry in `research/package/citation.bib` (kept apart from the manuscript's bibliography; the researcher edits it in Settings or the Export dialog). Never add this work's entry to the manuscript's bibliography for exporting.

A package definition may name the same concept as one of this project's definitions (`lib_hk_sobolev_space` and `sobolev_space`). Never merge them, edit either to match, or repoint results on your own: whether two definitions mean the same is the researcher's call. Compare the defining statements, then record the proposal as an idea for the researcher:

```bash
node .agents/skills/research-loop/scripts/research-loop.cjs idea add --kind observation --title "Same as: lib_hk_sobolev_space and sobolev_space" --body "<the two defining statements side by side, and why they agree or where they differ>"
```

If the researcher agrees, repoint the project's results to the definition they choose (`uses_definitions`), which sends those results back for review; resolve the idea with `idea resolve <idea> --by <definition id>`. If they disagree, leave both, and qualify the title of the project's definition if the names could be confused.

## Finish

Run `research-maintenance validate` and fix every problem, then `research-maintenance links --preview` and `--apply` for the new or changed bodies (see that skill for review of missed mentions). Run `check-notation` on new or materially revised assets. If the researcher asked for candidates rather than files, return the same content as Markdown blocks with YAML frontmatter. Flag uncertain readings and source passages that still need checking.
