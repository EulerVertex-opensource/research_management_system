---
name: extract-research-nodes
description: Extract draft research nodes - theorem-like results, examples, definitions (every concept a kept result uses, standard or newly introduced), assumptions, conventions, and remarks - from an imported paper transcription, research notes, or existing assets, into the project or into the library of known results. Use when turning source text into assets or definitions, when the researcher asks to organize, sort, or ingest research materials, or when importing earlier theorems or a useful paper's results into the library; use import-math-paper first for a new PDF.
---

# Extract research nodes

Scope the request: `results` (theorems, lemmas, propositions, examples, constructions), `definitions`, or `all`, and the target: the **project** (results this research will prove or use) or the **library** (known results: the researcher's earlier theorems, results of a paper they know is useful). Read `.research-assistant.json` for folder paths, then the relevant transcription, notes, or asset bodies. Check the source PDF for any ambiguous statement, formula, numbering, or attribution when it is available. Search existing assets, definitions, and the library (`research-loop library search <words>` when the loop is installed) before creating a node, and reuse a matching one.

## Organizing materials

When the researcher hands over a batch of materials to organize, sort each part to its one destination and extract it; do not invent another structure:

- A written manuscript, or results the researcher proved (a draft, partial results, proofs they want checked): the main TeX document when it already holds the paper, a Markdown draft, or notes with their own proofs. Its mathematics and its prose have different destinations, in this order:
  1. It is the researcher's own work: extract all of it as written, `source.kind: original`. Every result becomes an asset with its statement and proof (under `## Proof`; a result they state without proof gets none), and every definition it states, standard or newly introduced, becomes a definition node (Definitions, assumptions, and conventions). A proof's `\ref` or `\cite` to another result becomes a `depends_on` or a cited library or paper node, and a use of a defined term or notation becomes a `uses_definitions`, so the graph reproduces the manuscript's dependencies.
  2. Finish and Check below. When the researcher asked you to verify or check their results, pass `--requested` to `check next`, so the checks run whatever the setting says.
  3. Where their results stand (Check below): when the checks found gaps or some results have no proof, show the researcher the report and ask whether the research loop should complete them. On their yes, `start --intake` takes over: the loop drafts `project.md` from their main results, fills the gaps, proves the rest, and you drive it from this chat with the research-loop skill. Otherwise (everything passed, or they decline), propose `project.md` text from the abstract and introduction, with the main theorems as `required_results`, and request approval of the extracted nodes (`request_approval`) so the researcher reviews them together, each with its check's verdict.
  4. The prose, only for a manuscript and only once the mathematics is settled as above: `plan-manuscript` (scope adopt) splits the TeX into section files and writes briefs citing the new node IDs, then `draft-latex` wraps the passages that present them in blocks. A Markdown draft gets the outline and briefs only; `draft-latex` writes its TeX when the researcher asks. When this chat now drives the loop, leave the prose for the loop's `ready` stage or a chat of its own, and tell the researcher so.
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
- Create `collection.md` in a new collection: frontmatter saying where it comes from, then one paragraph on the source (who, what, where to find it). For a paper, index it first (as for any citation) and name it; every result in that collection must then cite that paper with its exact location, and validation reports one that does not:

  ```markdown
  ---
  title: Smith, Rigidity of collapsing manifolds
  kind: paper          # paper | note | thesis | other
  paper_id: smith2021  # only for kind: paper; an ID from the paper index
  ---
  The main theorem and the two lemmas of Smith 2021 used here.
  ```

  Keep one paper per collection; results from another paper go in that paper's collection.

The researcher checks each extracted result against its source in VS Code (Library: a card per collection, then *Check N results…*, one result at a time beside its location); the research loop then uses it as known and never re-proves it. There is no bulk acceptance for extracted results: a dropped hypothesis or a wrong theorem number would become a known result. When the researcher wants extracted results checked (Check below), an independent agent compares each result with its cited location right after extraction, and the researcher checks with its verdict; with auto mode for citations (or autonomous mode) a result that passes is approved, and one that fails waits for the researcher. After a batch, list the new IDs per collection with their locations so the checking is quick. Removing a whole collection is the researcher's action in the Library; its paper stays indexed.

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

## Check

After writing nodes into files (not candidates), and unless the loop's own `scaffold` or `sources` stage is extracting (the loop checks those itself), run in this chat:

```bash
node .agents/skills/research-loop/scripts/research-loop.cjs check next --ids <every node you created or changed> --source <the source file, or the paper slug>
```

It says whether the researcher wants extracted results checked (Settings, How thorough: *Check what is extracted*). When that is off, go on to approval. When it is on, it hands out one task per node: a definition for what its users need, a result taken from a source against its location, a written proof (the researcher's manuscript, say) step by step as written. A statement without a proof is skipped: the loop proves it later.

- You extracted these nodes, so never check them yourself. Run each task in its own fresh subagent (`research-worker-deep` where available; several in parallel, all in one message), giving it only its instruction. The subagent records its verdict with `check verdict`.
- Run `check next` again until every node is checked. With `--source` it then hands out one coverage check, which compares the source with what was extracted. Extract what it finds missing (validate and link as above), add the new IDs to `--ids`, and run `check next` again. After two coverage checks in a row that found gaps, the rest goes to the researcher.
- Then, when every proof passed and every result has one, request approval. Each request carries its node's verdict; with automatic approval, what passed is approved.
- When a proof did not pass or a result has no proof, `check next` says so. Run `check summary --ids <the same IDs>` and tell the researcher, by result title, where their results stand: the main results, what passed, each gap the checks found (the step and what is missing), and what has no proof yet. Then ask with `ask_researcher` (kind `discussion`) whether the research loop should complete them: check each proof as written, fill the gaps keeping the rest of their argument, prove what has no proof, starting from goals drafted from their main results. On their yes, run `research-loop start --provider claude|codex --intake <the same IDs> [--source <file>]` (`extend --intake` when a loop already runs, or the project is already approved), and from then on drive the loop here with the research-loop skill. On their no, request approval for what passed and leave the rest with them. Never rewrite the researcher's own text unasked: a failed check of their proof is theirs to judge until they ask the loop to repair it.
- If the researcher asks for a repair of one result later, inside a running loop: `research-loop repair request <id>`.

`check` never drives the research loop: running it does not make this chat the loop's chat, takes no lock, and leaves the loop's stage and context pack alone. Never run `research-loop next` or `report` here for the checks. `start --intake` does start the loop, and only on the researcher's yes. If a hook says this chat writes the manuscript and may not drive the loop, tell the researcher to invoke the research-loop skill here themselves (`/research-loop`; Codex `$research-loop`), which hands this chat the loop, or to open a new chat for it.
