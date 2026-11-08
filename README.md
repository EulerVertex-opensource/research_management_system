# Research Assistant — VS Code Extension

A file-based mathematical research workspace designed to live inside an Overleaf Git project. LaTeX and authored research context are shared through Git; extension-generated agent setup, source PDFs, and build output stay local.

## Overleaf-first workflow

1. Create or open a project in Overleaf and enable its Git integration.
2. Clone the Overleaf project and open that clone in VS Code:

   ```bash
   git clone https://git.overleaf.com/<project-id> my-paper
   cd my-paper
   code .
   ```

3. Run **Research Assistant: Open Dashboard**.
4. Open the Project panel and select **Initialize Shared Research Scaffold**.
5. Review and commit the authored research context, `.research-assistant.json`, and `.gitignore`, then push them to Overleaf. Generated skills, guidance, and local editor settings are ignored.
6. Collaborators using the same extension version clone the project, open it in VS Code, and run **Research Assistant: Refresh Project Setup**. The committed `.research-assistant.json` makes every installation use the same paths and context.

Initialization discovers an existing root-level `.tex` file containing `\documentclass`, preferring `main.tex`, and discovers common BibTeX, preamble, macro, and notation files. Existing files are never overwritten. Edit `.research-assistant.json` if the detected layout needs adjustment, then run **Research Assistant: Refresh Project Setup**.

## Shared workspace structure

```text
overleaf-project/
  main.tex                         ← existing Overleaf main document
  sections/                        ← manuscript sections, when used
  figures/                         ← manuscript figures
  macros.tex                       ← optional; discovered/configured
  notations.tex                    ← optional; discovered/configured
  references.bib                   ← discovered/configured bibliography

  research/                        ← authored research context is shared
    README.md                     ← generated locally; ignored
    project.md                     ← research contract: problem, scope, required results
    style.md                       ← proof style the researchers agreed on (teach style --add)
    papers.md                      ← paper index keyed by BibTeX slug
    assets/                        ← theorem/lemma/etc. nodes
    definitions/                   ← definitions and their notation
    ideas/                         ← freeform research ideas
    plans/                         ← proof plans, one per attempt (pending/failed/succeeded)
    library/<collection>/          ← known results (earlier theorems, useful papers), lib_ IDs
      assets/ definitions/        ← approved once, used as known, never re-proved; edits return them to draft
    library/<alias>/               ← an imported research package: same layout, read-only
      package.lock.json           ← version, source, and digest of every imported file
    package/                       ← this project as a package: manifest.json, releases.json, citation.bib
    writing/
      outline.md                  ← ordered manuscript section links
      sections/<id>.md            ← section briefs and asset IDs
    papers/<slug>/                 ← shared metadata and working transcriptions
    checks/                        ← falsification checks and object-search round summaries (obstructions, limitations)
    candidates/                    ← object-search candidates: each object tried, with a pass/fail verdict per property
    decisions/                     ← researcher directions, change requests, parked results (loop-written)
    handoffs/                      ← where each collaborator stopped and what comes next
    approvals/                     ← one approval record per approved result, one per accepted package (extension-written)

  research-local/                  ← local only; ignored by Git
    raw_papers/                    ← authoritative source PDFs
    packages/                      ← exported .rpkg.json files (default location)
    package-cache/                 ← local clones of packages imported from git
    understanding.json             ← what you marked as understood (teach skill); yours alone

  .latex-out/                     ← local PDF and LaTeX build artifacts; ignored

  .research-assistant.json         ← committed path configuration
  .gitignore                       ← committed local/generated-file exclusions
  .gitattributes                   ← union merge for the append-only paper index and BibTeX
  .vscode/                         ← generated local build settings/recommendations
  .github/copilot-instructions.md  ← generated local Copilot guidance
  .agents/skills/                  ← bundled Codex skills local; project skills shared
  .claude/skills/                  ← bundled Claude skills local; project skills shared
  AGENTS.md                        ← generated local agent guidance (Codex and Claude Code)
```

Overleaf should compile the existing root document exactly as before. Research Assistant does not insert inputs into an adopted manuscript or replace its bibliography.

## What is shared

Commit these files:

- LaTeX, BibTeX, figures required by the manuscript, and project-specific class/style files.
- `.research-assistant.json` and the managed `.gitignore`.
- Authored research files: `research/project.md`, `research/papers.md`, nodes in `research/assets/`, `research/definitions/`, `research/ideas/`, and `research/plans/`, writing plans in `research/writing/`, and metadata/transcriptions in `research/papers/`.
- Research loop records: `research/checks/`, `research/candidates/`, `research/decisions/`, `research/handoffs/`, and `research/approvals/`. These carry what the loop learned (which counterexample and construction searches were done and which objects failed which property, why a result is parked, what direction a researcher gave, who approved which version on which commit), so a collaborator's loop continues from the same point. The loop's run mechanics in `.research-assistant-loop/` (bridge token, session lock, stage snapshot, autopilot counters) stay local.
- Project skills under `.agents/skills/` or `.claude/skills/` whose names do not match an extension-bundled skill.

Do not normally commit:

- `research-local/raw_papers/*.pdf`.
- OCR caches or extraction scratch files.
- Python bytecode caches (`__pycache__/`, `*.pyc`).
- LaTeX output such as `.aux`, `.log`, `.fls`, `.fdb_latexmk`, `.synctex.gz`, and `.toc` files.
- A compiled copy of the manuscript PDF.
- Everything under `.latex-out/`.
- Extension-bundled skill folders under `.agents/skills/` and `.claude/skills/`, `.github/copilot-instructions.md`, `AGENTS.md`, a local `CLAUDE.md` if you keep one, and generated `.vscode` settings/recommendations.

The generated `.gitignore` names each extension-bundled skill folder separately. On refresh, it replaces the former broad `.agents/skills/` and `.claude/skills/` ignore rules, so other skill folders can be added to Git. Bundled skill names are reserved because refresh updates those folders. Ignore rules do not remove files Git already tracks. For an existing project, review tracked generated files and remove only those from the Git index with `git rm --cached` (or `git rm -r --cached` for generated directories), then commit that change. Their local copies remain. Keep `.research-assistant.json`, TeX/BibTeX, authored research context, and project skills tracked. Refresh no longer creates `research/workflows/` or ignores its files; existing workflow files remain in place and can be reviewed for removal or tracking.

`AGENTS.md` is the single agent guidance file: Codex reads it, and Claude Code reads it natively whenever no `CLAUDE.md` exists in the project folder or above it. Refresh therefore deletes a `CLAUDE.md` that only held the old generated copy; if you keep your own `CLAUDE.md`, refresh replaces the old copy with an `@AGENTS.md` import so Claude still loads the same guidance. This needs a Claude Code version that reads `AGENTS.md`. `AGENTS.md` and `CLAUDE.md` are ignored by default even though refresh preserves local text outside the generated markers. Put guidance that must reach every collaborator in tracked `research/project.md`, or explicitly force-track a custom instruction file after deciding that its generated section will change on refresh.

For each paper, share a stable DOI, arXiv, or publisher URL and a checksum when available. This lets collaborators retrieve and verify the same authoritative PDF without storing large binaries in the Overleaf repository.

## Collaboration practice

Use the loop's sync commands instead of raw `git pull`/`push` while the research loop is in use. Plain git stays fine for the manuscript when no loop is running.

```bash
research-loop sync status            # ahead/behind, uncommitted research, latest handoff
research-loop sync pull              # fetch + rebase, validate, invalidate stale approvals, rebuild loop state, research summary
research-loop sync prepare [--latex] # pre-share checklist; writes a handoff
research-loop sync publish           # commit research + manuscript paths only, re-validate after rebase, push; asks the researcher to confirm
```

(`research-loop` is `node .agents/skills/research-loop/scripts/research-loop.cjs`; the same actions are the **Research Assistant: … (Git)** commands.)

The dashboard's **⇅ Sync** button (also **Research Assistant: Sync Research (Pull and Publish)**) does this in one click, for collaborators who do not use git. Under the button, a line shows how many changes are waiting to be shared or pulled. If there is local work, Sync runs prepare. When the checks pass, it publishes after you confirm; publish also brings in collaborators' commits first. If there is no local work, it pulls. When something needs a person (a failed check, a conflict, an unreachable remote, or an agent in the middle of a step), the dashboard shows what to fix. Nothing is force-pushed, and conflicts are never resolved automatically.

- **Pull** refuses while a stage has unreported edits and while research files are uncommitted. On conflicts it stops, pauses the loop, and never picks a side. When two people changed the same statement, the researchers decide. Resolve, finish the rebase or merge, then `sync pull --continue`. If someone ran a raw `git pull` mid-stage, `report` refuses to count those files as the agent's; `sync pull --continue` re-baselines.
- **Prepare** checks that:
  - the stage is reported and every research file is valid
  - dependencies resolve and there are no cycles
  - approvals still match their content
  - cited papers have an index entry, exact location, stable URL, and BibTeX entry
  - BibTeX keys are unique
  - the manuscript compiles (with `--latex` and `sync.latexCommand`)
  - upstream has no newer commits
- **Publish** needs a fresh prepare and the researcher's confirmation: a VS Code dialog, or `--interactive` in a terminal. Agents cannot confirm it. After pushing to `sync.remote`, it fast-forwards `sync.overleafRemote` when configured and never force-pushes Overleaf.

Recommended topologies:

- **Overleaf only** (small teams): `sync.remote` is the Overleaf remote and `sync.branch` is `master`. Overleaf Git has a single linear `master` history, so publish rebases onto it.
- **GitHub primary, Overleaf mirror** (several active researchers): each researcher works on a branch and opens pull requests on GitHub for review and CI. After merging to `main`, one designated person publishes with `sync.overleafRemote` set, so Overleaf receives `main` as a fast-forward.

Overleaf [warns](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/advanced-git-operations) that Git pushes can lose or displace comments and tracked changes. Keep research discussion in ideas, decisions, and handoffs, not only in Overleaf comments.

Prefer one node per file so independent results merge cleanly. Approvals are one file per target for the same reason; `research-loop migrate-approvals` (also run on **Refresh Project Setup**) splits a legacy `research/approvals.json`. Avoid renaming files that have active Overleaf comments or tracked changes, because a Git-side rename is represented as delete-and-create by Overleaf.

### Automatic pull

The extension fetches `sync.remote` on startup, when the VS Code window regains focus (at most once a minute), and every `researchAssistant.sync.autoPullIntervalMinutes` minutes (default 5; `0` disables the timer). If the remote is ahead, it runs the same `sync pull` as the command, but only when the working tree has no uncommitted changes and the research loop is not running. Otherwise it adds a **Pull now** card to the Overview's *Needs you* list, once per new remote commit. Set `researchAssistant.sync.autoPull` to `notify` to only be told, or `off` to disable it. Fetch failures, such as missing Overleaf credentials, are logged to the Research Assistant output channel without a popup.

## Research packages

A finished project can be reused by later ones, the way a library is imported in a programming language. Exporting packages the project's approved results; importing one copies them into another project's library, with the citations they need, as known results that are never re-proved there.

- **What goes in.** The results under `exports` (by default the `required_results` of `project.md`) and everything they depend on, through `depends_on` and `uses_definitions`, including library results. Every one must be approved, and none may be a conjecture: a result that rests on a conjecture is conditional and cannot be exported. Ideas, plans, checks, decisions, remarks, and all manuscript files stay behind. A result proved in the project is cited, in the importing project, as this work at the location given when exporting (for example *Theorem 1.2*); a cited result keeps its citation.
- **This work's citation.** How importers cite this project is its own BibTeX entry in `research/package/citation.bib`, kept apart from the manuscript's bibliography, since a paper does not cite itself. Edit it in **Settings → This project's citation**, in the Export dialog, or with `package citation --set FILE`. It is one entry whose key is lowercase snake_case (importers use it as a paper-index slug) and which has a title; give it a `url`, `doi`, or `eprint` so importers have a stable link. Update it as the paper moves from preprint to journal and export again: importers get it with their next update.
- **Versions.** A statement is a result's interface and its proof the implementation, so versions follow semver from the content: a changed statement or a removed result is a major change, an added result a minor one, a changed proof a patch. Each export proposes the version and records the release in `research/package/releases.json`; share that file like any research file.
- **Importing.** A package comes from an exported `.rpkg.json` file, from another project's folder, or from a git URL with an optional branch, tag, or commit (`https://github.com/alice/heat-kernel.git#research-v1.2.0`). Its files land in `research/library/<alias>/` with IDs `lib_<alias>_<id>`, and `package.lock.json` pins the version, the source, and every file's digest. The package's BibTeX entries are merged into the bibliography by the work they name: an entry already present (same DOI, arXiv ID, or title and year) is reused, a key taken by a different work is renamed `<key>_<alias>`, and the paper index gains an entry for each. An imported collection is read-only: validation reports any edited or added file, and the agent hook refuses edits. To change a result, `library promote` copies it into the project.
- **Accepting.** The researcher accepts a package once, from the Library, from *Needs you*, or with `package approve <alias> --interactive` in a terminal; its results then count as approved under one record in `research/approvals/packages/<alias>.json`. Agents cannot accept packages.
- **Updating.** An update shows what changed between the versions. Results that did not change stay accepted; changed ones wait for the package to be accepted again; and approved results of this project that rest on a changed statement are reverted or flagged for a re-check, following the setting *When something a result rests on changes*. An update that drops a result still in use is refused.
- **Removing.** Removal deletes the package, its approval record, and the BibTeX entries and paper-index sections only it used; entries cited elsewhere, by a node or in the TeX, stay. It is refused while results of this project still use the package.

In the dashboard, the Library lists its collections as folds, packages first. At its top, **Import a package…** (from a file, a project folder, or a git URL; it previews everything before writing) and **Export this project…** (name, this work's citation, results to export, locations, and the proposed version). Each imported package's fold shows its version, whether it is accepted, and **Accept**, **Update…**, and **Remove**. The same actions are commands: *Import Research Package…*, *Export This Project as a Research Package…*, *Update Imported Research Package…*, and *Accept Imported Research Package…*. Changing packages waits while a loop stage is in progress.

From a terminal, each command previews and writes only with `--apply`:

```bash
research-loop package citation [--set FILE]
research-loop package export [--name N] [--citation FILE] [--exports a,b] [--location id="Theorem 1.2"] [--version X.Y.Z] [--out FILE] [--apply]
research-loop package import <file.rpkg.json | project folder | git URL[#ref]> [--as alias] [--apply]
research-loop package update <alias> [<source>] [--ref REF] [--apply]
research-loop package remove <alias> [--force] [--apply]
research-loop package approve <alias> --interactive
research-loop package list | package verify
```

To publish a package through git, export (which records the release), share the project with **Sync**, and optionally tag that commit. A git import at that commit then gets the recorded version; a commit with unreleased changes builds as a prerelease such as `1.1.0-dev`. Git sources are fetched with your own git credentials into `research-local/package-cache/`; only the research files are read.

### Collections from papers and notes

Known results extracted from a paper, your notes, or a thesis live in their own collection, `research/library/<collection>/`, beside the packages. Nothing upstream vouches for them, so they are governed differently: each result is checked against its source one at a time, and the files stay editable (an edit sends a checked result back to unchecked). `collection.md` says where a collection comes from:

```markdown
---
title: Smith, Rigidity of collapsing manifolds
kind: paper          # paper | note | thesis | other
paper_id: smith2021  # for kind: paper, an ID from the paper index
---
The main theorem and the two lemmas used here.
```

A paper collection holds every result to its paper: each must cite `smith2021` with an exact location, and validation reports one that does not. Without a declared kind, a collection whose results all cite one paper is treated as that paper's. In the Library, each collection's fold shows its paper, how many results are checked, and **Check N results…**, which steps through the unchecked ones, each with its place in the source and **Open paper**; **Remove…** deletes the collection's results and their approval records (refused while a result here still uses one) and keeps the paper in Papers and the bibliography.

## Configuration

The default generated `.research-assistant.json` is:

```json
{
  "version": 1,
  "layout": "overleaf-shared",
  "latex": {
    "projectRoot": ".",
    "main": "main.tex",
    "bibliography": "references.bib",
    "macros": ["macros.tex"],
    "notations": "notations.tex",
    "sections": "sections"
  },
  "research": {
    "root": "research",
    "project": "research/project.md",
    "paperIndex": "research/papers.md",
    "assets": "research/assets",
    "definitions": "research/definitions",
    "ideas": "research/ideas",
    "plans": "research/plans",
    "papers": "research/papers",
    "localSourcePdfs": "research-local/raw_papers"
  }
}
```

An optional `sync` block configures git collaboration. Defaults are shown; `overleafRemote`, `latexCommand`, and `identity` are unset by default:

```json
"sync": {
  "remote": "origin",
  "branch": "main",
  "overleafRemote": "overleaf",
  "overleafBranch": "master",
  "strategy": "rebase",
  "include": [],
  "latexCommand": "latexmk -pdf -interaction=nonstopmode -halt-on-error -cd -outdir=.latex-out main.tex",
  "signCommits": false,
  "identity": "alice@example.edu"
}
```

`branch` defaults to the current branch. `overleafBranch` is used only for pushes and pulls to `overleafRemote`; when `remote` is itself the Overleaf clone, the current branch (Overleaf's `master`) is used. When `latexCommand` is unset, `sync prepare --latex` runs `latexmk -pdf` on `latex.main` with output in `.latex-out/`. `include` adds paths to publish commits beyond the research folders, the manuscript files, and `.research-assistant.json`. `identity` overrides `git config user.email` as the name recorded on approvals, checks, decisions, and handoffs.

All paths must remain within the workspace. LaTeX paths are relative to `latex.projectRoot`; research paths are workspace-relative. Macro files may be an empty array and `notations` may be `null` for projects without dedicated files.

Existing workspaces using `manuscript/`, root `assets/`, root `ideas/`, and `raw_papers/` are detected as `legacy`. Their plans folder defaults to root `plans/`. Existing plans in `ideas/` remain readable until migrated.

## Local manuscript build and preview

Research Assistant uses [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) as an optional build engine and renders its PDF directly in the **Manuscript** panel. Each collaborator who wants local builds must install:

1. The recommended LaTeX Workshop VS Code extension.
2. A local TeX distribution that provides `latexmk`, such as TeX Live, MacTeX, or MiKTeX.

After pulling the project and refreshing the Research Assistant scaffold, open **Manuscript**. An existing `.latex-out/<main-file-name>.pdf` opens in the panel automatically; **View compiled PDF** reloads it without building. Select **Compile Manuscript** to rebuild the configured main TeX file, even if an included section is currently open. Standard auxiliary files and the compiled PDF are written to the repository-root `.latex-out/` directory, and the embedded viewer refreshes when that PDF changes.

The locally generated workspace defaults are:

```json
{
  "latex-workshop.latex.outDir": "%WORKSPACE_FOLDER%/.latex-out",
  "latex-workshop.latex.auxDir": "%OUTDIR%",
  "latex-workshop.latex.autoBuild.run": "never"
}
```

Use the **Build on save** checkbox in Manuscript to switch the last setting between `never` and `onSave`. This is a local preference in each collaborator's clone; refresh preserves it. If a project already has conflicting output settings, Research Assistant shows them and waits for an explicit **Use Research Assistant build setup** action.

Overleaf still compiles the tracked source independently. Commit accepted manuscript section `.tex` files; do not push `.latex-out/`, auxiliary files, or compiled PDFs. Overleaf likewise [recommends excluding auxiliary and local output files](https://docs.overleaf.com/managing-projects-and-files/adding-files-to-a-project/uploading-files-to-a-project/files-that-should-not-be-included-in-a-project).

## Modular manuscript writing

The canonical paper is the configured main TeX file plus editable files in its configured sections folder. The writing plan is shared Markdown under `<research.root>/writing/`; it is separate from `research/plans/`, which records mathematical proof attempts. Refresh project setup to create an empty `outline.md` without changing existing TeX.

Under `## Sections`, add numbered links in presentation order. The link text must match the brief's `title`, and each stable ID names both a brief and a TeX file:

```markdown
1. [Introduction](sections/introduction.md)
2. [Main result](sections/main_result.md)
```

Each `writing/sections/<id>.md` brief has a short YAML header and prose:

```markdown
---
title: Main result
assets: [main_theorem, key_lemma]
---

## Purpose

Explain what the reader should learn in this section.

## Subsections

- State the main result, then establish the key lemma.

## Gaps

- Record any unproved step or draft result here.

## Excluded

- sanity_check_small_n: verified special case, not needed for the argument
```

Use `plan-manuscript` with a researcher to decide the section order (scope `manuscript`) or to refine one brief (scope `section`). The agents begin with a compact node index and read full content only for selected results. To validate a brief and list the exact approved assets, dependency definitions, preamble files, and BibTeX keys needed for drafting, run:

```bash
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs prepare main_result --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs prepare main_result --apply
```

`--apply` creates `sections/main_result.tex` only if it is missing. The `draft-latex` skill replaces that untouched skeleton with a first draft and thereafter edits only requested passages. It marks uses of research nodes with `% [node_id]` comments; printed references use normal LaTeX labels and verified bibliography keys. Unknown or unapproved dependencies stop preparation.

Assets that were correct but only served completeness or an earlier experiment go under `## Excluded` in the brief, so drafts and updates leave them out. After drafting, `revise-manuscript-prose` reviews the section for an expert reader. It checks for transitions between blocks, compressed routine detail, no asset codes such as (M1), and direct wording, and it leaves the mathematics unchanged. The rules are in `draft-latex/references/style.md`.

When every listed TeX section exists, preview and apply the main document's input order:

```bash
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs sync --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs sync --apply
```

For a new document, Research Assistant creates the input markers in `main.tex`. The command changes only the text between them; it refuses to guess an insertion point in an existing manuscript.

An existing manuscript (an Overleaf project whose `main.tex` already holds the paper) is adopted once:

```bash
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs adopt --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs adopt --apply
```

It cuts the body at each `\section`, from the first heading up to the bibliography, and moves each piece unchanged into `sections/<id>.tex`. `main.tex` gets one `\input` per section between the markers and keeps its preamble, front matter, and bibliography. It then writes the outline in the manuscript's order and one brief per section. The ID comes from the heading's `\label{sec:...}`, or from its title. If `main.tex` already inputs files from `sections/`, only the markers are added. The section files concatenate to the original text, so the compiled document is unchanged. Moving text out of `main.tex` detaches Overleaf comments and tracked changes on it, so the agent asks before `--apply`. When you ask the agent to organize such a project, it first extracts the results and definitions into nodes, then adopts the manuscript, fills the briefs with those node IDs, and wraps the passages that present them in blocks; sections lock after you approve their nodes. Review the Git diff and compile after syncing. Use Git changes for coauthor review; [Overleaf warns](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/advanced-git-operations) that Git pushes can displace comments and tracked changes.

## Research loop from the agent chat

The research loop is a human-in-the-loop workflow driven from the Claude Code or Codex chat window; the extension provides the state machine, validation, popups, and approval records. Nothing runs headless.

1. Run **Research Assistant: Start Research Loop**, pick the agent, and optionally type the goal. The extension opens that agent's chat.
2. Type `/research-loop` in Claude Code or `$research-loop` in Codex. The skill runs `status`, `next`, does the stage (heavy stages in a subagent), and `report`s; the Stop hook keeps the agent going until the loop waits for you, is paused, or reaches the per-session cap (`researchAssistant.loop.iterationCap`).
3. Questions arrive as VS Code popups (`ask_researcher`, and the ones the loop raises itself when a result is stuck). Answer, skip, or pause. After the question timeout the setting *When a question goes unanswered* decides: the loop waits for you (Careful), or the agent goes on with its stated default (Fast); a late answer is shown to the agent on its next turn. Each tool call returns within about 45 seconds with `status: pending` while the popup is open, and the agent keeps waiting with `await_answer`, so no MCP client timeout can cut a question off.
4. Approvals (`request_approval`) wait as cards in the Overview's *Needs you* list (**Read it / Accept / Ask for changes…**); there is no popup for them. They also count when you set `status: approved` in the dashboard or the editor. Only the extension writes `research/approvals/`; each record carries who approved, the approved content and statement digests, the base commit, and the extension version. The agent is denied by a PreToolUse hook, and `validate --fix` reverts any approved node without a record.
5. The status bar says whose turn it is in words (yellow when a result holds up a main result, red when nothing is moving) and opens the Overview. A popup appears only when the loop has stopped and waits on you, when the agent has gone quiet for 20 minutes during a stage, or when the loop paused itself at its continuation limit; each situation is announced once. Commands: Pause, Resume, Stop, Answer Pending Loop Question, Review Pending Approvals, Capture Research Idea, Show Loop Status.
6. In the chat, the agent writes each result, definition, plan, or idea it names as a link to `.research-assistant-loop/open/<id>.md`, a small local file the extension keeps for every node. When an editor opens one, the extension closes it and opens that page in the dashboard. Chats render only web links and file paths (Codex drops `vscode://` links), which is why the link is a file. The extension also handles `vscode://tianhao.research-management-system/node?id=…` for other tools. **Open** in a review popup opens the dashboard page too.

Stages: `discuss_goals` → `draft_project` → `review_project` → `scaffold` → `sources` → per result `search` → (`search_summary`, `verify_counterexample`) → `plan` → `execute` → researcher approval → `ready`. A confirmed counterexample deprecates the refuted asset (the corrected statement gets a new ID) and returns to the project goals. After the failed-plan limit since the last direction the loop asks you for a direction; with none, the result is set aside, or (Fast) the agent tries one new approach of its own first. The definitions the main results' statements use are agreed before any proof work (Careful) or checked at the end (Fast); every definition must be approved before `ready`.

**How involved are you.** Settings → Research loop offers three levels. *Review everything* (the default): every result, definition, and goal waits for your approval. *Approve routine work*: the kinds you check (proofs, supporting results, citations, definitions by default; counterexamples, construction specifications, and project goals only if you tick them) are approved without asking you, each judged from its file; questions still come to you. *Work on its own*: autonomous mode, below. The same place sets what happens when you do not respond: whether the loop waits for definitions it drafted to fill a gap, what happens when a result is stuck and you give no direction, whether unanswered questions wait for you, and the question timeout.

**How thorough.** A *Careful* / *Fast* preset over four checks, each adjustable on its own: counterexample search before proving (every result, main results only, or never), who checks each proof (an independent agent, you, or nobody; see below), agreeing on definitions before proving, and what happens downstream when a statement or definition changes (everything back to review, or *Needs re-check* marks that you clear with **Still holds**). Careful is the default. How much effort a search spends (rounds, workers, limits) is a separate setting.

**Checking proofs.** The agent that plans a proof also writes it, so by default (*Careful*) a fresh agent verifies every proof before it goes to approval: the `verify_proof` stage sees the statement, the proof, and its dependencies' statements, but not the plan, and writes a `## Verdict` (confirmed or rejected, naming the first step that fails) at the end of the plan. A confirmed proof goes to approval as usual, and auto mode approves a proof only once it is confirmed. A rejected one fails its plan, leaves the asset, and counts as a failed attempt, so the next plan starts from the verdict. With *I verify every proof myself*, proofs always come to you and are never approved automatically, whatever the involvement level allows. With *No separate check* (*Fast*), a proof goes to approval as soon as it is written.

**When something a proof rests on changes.** A verification counts only against the current statements of the proof's dependencies and definitions. When one of them changes, the proof is checked again (`verify_proof` with a note naming what changed). A confirmed re-check lets auto mode approve the result again and lifts the hold the change put on it; a rejected one sends the result back to planning without counting a failed attempt. A change to a node itself, and an approval without a record, always come back to you. With *No separate check*, the re-check runs only when auto mode would otherwise approve the result.

**Checking definitions and cited results.** Auto mode (and autonomous mode) approves a definition, a result citing a paper, or a library result only after an independent agent checks that version in the `verify_node` stage: a definition for being well formed, fitting the results that use it, and not making a goal trivial or vacuous; a cited result against its source location. The verdict is kept as a shared decision record. A rejected node waits for you with the verdict and is not checked again until it changes. At hand-back, an autonomous run lists everything approved on an agent's check alone.

**Checking what is extracted.** With *Check what is extracted* on (How thorough; Careful turns it on, Fast off), results and definitions extracted from a manuscript, paper, or notes are checked by an independent agent right after extraction, in the chat that extracted them: a definition for what its users need, a result taken from a source against its location, and a written proof step by step as written. One more check compares the source with what was extracted and names anything missing. The checks run through `research-loop check`, which never drives the loop: the chat does not become the loop's chat, takes no lock, and leaves the loop's stage and context pack alone. Each approval request then carries its verdict; with automatic approval, what passed is approved, and a proof that failed is kept for you to revise. A checked proof is checked again when something it uses changes. When the loop's own scaffold or sources stage extracts, the loop checks the new nodes before anything else.

**No new approach.** When the plan stage sees no genuinely new approach, it reports `none` instead of writing a filler plan: nothing is executed, so no attempt is spent and no failed plan is recorded, and the result counts as stuck (you are asked for a direction; in autonomous mode the agent decides, and a second `none` right after its own direction sets the result aside).

**Autonomous mode.** Settings → Research loop → *How involved are you* → *Work on its own* lets the agent work without you: it asks nothing (questions are kept as ideas for you, with the default it chose), it approves every kind automatically, and when a result's attempts run out it decides itself whether to give it more (`budget allocate <asset> <n> --reason "..."`, which becomes the direction its next plans must follow) or to set it aside. When only set-aside results remain, it reassesses what the goals still need up to *Goal reassessments* times (each one after the first needs something proved or set aside since the last): it brings back a set-aside result that something new gets past, with its own direction, or adds a weaker statement, a special case, or another route as new required results. It never drops yours, which you decide about at hand-back. Each executed plan and each search round spends one attempt of the *Budget*; when the budget or the optional *Time limit* is used up, or nothing is left it can do alone, the loop writes a handoff, pauses, and shows one popup. Resuming starts a new run with a fresh budget.

**Object search.** Before a result is proved, the loop searches for a counterexample (refute mode, unless *How thorough* skips it); a construction whose statement lists required properties (`- P1: …`, `- P2: …`) is searched for instead of proved (construct mode), once you approve that specification. A search runs in rounds:
- **Workers.** In each round, parallel subagents each get a different direction (small cases, degenerate cases, adapting a known construction, repairing the best near-miss, trying to prove no object exists, or one of your `test_case` ideas). Each worker writes candidates to `research/candidates/` with a verdict per property, and stops checking a candidate at its first failing property.
- **Shared memory.** Workers share only a short search board the loop compiles from the shared records: obstructions, the best near-misses, and the directions already tried. A summary stage turns each round's failures into obstructions.
- **Survivors.** A candidate that passes every check goes to a fresh, independent verifier. A verified counterexample waits for your confirmation as before. A verified construction is written into the asset as `## Construction` and `## Proof` for your approval; its specification stays as approved.
- **When nothing is found.** A refute search that finds nothing writes the falsification check and moves on to planning. A construction search that reaches its round or candidate limit since your last direction asks you for a new direction, or parks the asset.
- **Limits.** Workers per round, rounds, the candidate limit, and the board size are all in **⚙ Settings → Research loop**. The loop never repeats a search on its own: ask for one in the chat, and the agent runs `search request <asset> [--rounds N]`. Those packs also show where earlier proof attempts broke.
- **Verifiers.** Checks are written arguments today (`verifier: reasoning`); the verifier field is where code or other checkers will plug in.

**Following the proofs (teaching chat).** The loop can prove results faster than anyone can read them, so you catch up at your own pace in a second chat beside the loop. Open a new chat and type `/teach` in Claude Code or `$teach` in Codex, or use **Research Assistant: Study Verified Results**, the *Study them in a new chat* link in the Overview, or *Walk me through it* on a result (each copies a prompt and opens the chat). The `teach` skill explains only verified results, those approved or with a proof an independent check confirmed:
- **What it starts from.** `research-loop teach list` lists what is new to you or changed since you studied it, each after the results it rests on. The teacher starts with how these results fit together, then takes one result at a time.
- **How it explains.** It goes one layer at a time, and you choose how deep: what the result says, the key idea, the skeleton, the hard step, line by line. Its material comes from `teach pack <id>`: the statement and proof, what it rests on, the attempts that failed and why, the independent check's verdict, and known results it adapts.
- **Reading the files yourself.** The teacher names each result, plan, and doubt as a dashboard link (see item 6 above), so a click opens that page in the dashboard. File links are given too: a research file open in the editor has a **Show in Dashboard** button in its title bar.
- **Remarks.** As you discuss a result, the teacher writes remarks on it like margin notes (intuition, why a step is needed, a picture to keep in mind), saved at once in `research/remarks/`, one file each. The loop adds its own remarks too (the key idea of a proof it found), marked as unchecked. Remarks are annotations, not results: nothing depends on them, no approval or check covers them, the loop never reads them, and the dashboard shows them under their result.
- **Rewording a proof.** When you dislike how a proof is written, the teacher rewords it with you in the chat and proposes the result with `teach revise`. Only a running loop applies a rewording, between stages; if the loop is not running, paused, or waiting, the teacher tells you to start, resume, or nudge it.
  - **Checking.** A reworded proof is always checked independently, whatever *Check each proof* says. Confirmed, it replaces the old one and comes back to you for approval, and your understanding mark moves to the new wording. Rejected, the old proof (and its approval) comes back, and the rewrite plan records why. Neither counts as a failed attempt.
  - **What can change.** The statement never changes. Remarks sit in a block that changes no approval and no verification.
  - **The paper.** How the paper presents a proof is a separate layer: the manuscript skills change only the LaTeX, never the result's file.
- **Proof style.** Preferences you want for the whole project ("use we", "number the constants") go to `research/style.md` with `teach style --add`, once you agree. It is shared with collaborators. New proofs the loop writes follow it, and so do rewordings.
- **Your doubts.** When you doubt a step, the teacher checks it with you and records the doubt as a risk idea on that result. The loop's chat picks it up there.
- **What it may do.** The hooks keep the teaching chat from taking the loop's lock, from being sent on at Stop, from driving the loop, and from editing project files.

What you understood is yours alone. For each verified result you mark one of three levels: *what it says* (you can use it as a black box), *the key idea*, or *every step*. You set it in the teaching chat's popup (`mark_understood`), under **What you know of it** on a result in Results, or with `teach mark <id> --level … --interactive` in your own terminal; agents cannot set it. It is stored in `research-local/understanding.json`, which is never shared. Each mark records the statement and proof you studied:
- a changed statement shows the result as new to you again;
- a changed proof leaves you at *what it says*;
- the teacher can show you what changed since your version.

The status bar and the Overview show how many verified results are new to you. By default the loop never waits for you to catch up. If you prefer it to, set **⚙ Settings → Research loop → Keeping up with the proofs → How far the loop may get ahead of you**. Once that many verified results are new to you, the loop starts no new proof until you catch up. Working on its own ignores this limit.

Generated locally on refresh and ignored by Git: `.claude/settings.local.json` (hooks, permissions), `.mcp.json`, `.codex/hooks.json`, and `.research-assistant-loop/` (state, events, bridge). Claude Code asks once to trust the project MCP server; Codex asks once to trust the project hooks under `/hooks`. Codex reads MCP servers only from its user config, so refresh registers the bundled bridge once with `codex mcp add research-assistant`; the bridge finds the open project through `~/.research-assistant/bridges.json`, which the extension maintains while it runs. The CLI behind the skill is `node .agents/skills/research-loop/scripts/research-loop.cjs` (`status`, `start`, `next`, `report`, `validate`, `park`, `idea add|convert`, `question`, `handoff`, `search status|request`, `teach list|pack|mark`, `sync status|pull|prepare|publish`, `migrate-approvals`). On `start` and after every `sync pull`, parked assets, change requests, falsification, search progress, and failure counts are re-derived from the shared records, so a fresh clone continues where a collaborator stopped.

Claude Code and Codex use the same skills, CLI, hooks, and MCP bridge. Everything that differs between them (extension ID, chat command, `/` or `$` prefix, skill folder, hooks file, write-tool matcher, MCP registration) lives in one table, `src/services/AgentProviders.ts`. Both agents receive the same JSON hook output. Codex reads `skills/research-loop/agents/openai.yaml`, which disables implicit invocation just as `disable-model-invocation` does for Claude Code.

## Dashboard

| Panel | Purpose |
|---|---|
| **Overview** | What is happening now and whether you are needed: what the agent is doing, the most urgent item that waits for you (with its next two), progress on each main result, and the last few events. No graph here |
| **Needs you** | Everything that waits for you, grouped by consequence; pick one to see why, what it holds up, and what you can do |
| **Results** | The research structure as a list or a graph (one switch): *Still to do* per main result with finished branches folded, *Held up*, or *Everything*. A chosen result opens in a side panel, which can narrow the view to what it rests on or what rests on it, including the passages of the paper |
| **Activity** | The full timeline of what the agent and you did |
| **Project goals** | Edit the project contract, with derived status (required results, open questions, manuscript sections) above it; initialize or refresh shared setup |
| **Definitions** | Browse and edit definitions, assumptions, and conventions (`definition_kind`) and their notation, listed in dependency order |
| **Assets** | Browse and edit theorem, lemma, proposition, example, construction, and conjecture nodes, with their remarks |
| **Library** | Known results (`lib_` IDs) as one card per collection: imported packages (accepted once, as a whole) and collections extracted from papers and notes (each result checked against its source, one at a time). Each collection is a fold, like the Results list, that opens onto its results; folds that need you start open |
| **Plans** | Browse and edit proof plans, including failed and succeeded attempts |
| **Ideas** | Browse and edit freeform research ideas |
| **Remarks** | Every remark on a result (yours, the loop's, the teaching chat's): filter, read, edit, archive, approve one for the paper, or write a new one |
| **Papers** | Edit the configured bibliography and paper index; add local PDFs plus shared source URLs |
| **Manuscript** | Compile the configured main TeX file and read the generated PDF inside Research Assistant; *Which results it covers* shows which section presents each result and whether it is up to date |
| **⚠ File problems** | Appears only when research files do not fit together (duplicate IDs, a dependency on a retired result); lists them and can ask the agent to fix them |
| **⟳ Refresh** | Re-read the configuration and every research file from disk and update all panels |
| **⇅ Sync** | Pull collaborators' changes and share yours (see [Collaboration practice](#collaboration-practice)) |
| **⚙ Settings** | Display (*Show technical details*: node IDs, file paths, and the agent's raw last step; off by default), agent, research loop (how involved you are, how thorough it is, search and effort), sync, and context-budget settings |

Node changes are reflected live; **Refresh** catches anything the file watchers missed. New or materially changed assets and definitions remain `draft`; only a researcher should promote them to `approved`. New directions start `draft`, and new proof plans start `pending`.

## Project contract

`research/project.md` says why the work is done and when it is complete. Its frontmatter lists the results the project must establish; the research loop is `ready` when all of them and their dependencies are approved:

```markdown
---
type: project
schema_version: 2
required_results:
  - id: main_theorem
    role: central contribution
---

# Project

## Main Problem
## Scope and Assumptions
## Intended Contribution
## Background
```

A project approval covers the main problem, scope (including project-level decisions and assumptions), intended contribution, and required results; background is context. Known results, open questions (ideas with `idea_kind: question`), researcher decisions (`research/decisions/`), and writing progress each live in their own files and are shown above the editor in the Project panel, so project.md does not restate them.

## Node format

An asset at `research/assets/<id>.md` uses YAML frontmatter:

```markdown
---
type: theorem
title: Chebotarev Density Theorem
status: draft
source:
  kind: paper
  paper_id: lang_weil
  location: Theorem 3.1
depends_on:
  - frobenius_conjugacy_class
uses_definitions:
  - subgroup
tags:
  - arithmetic-geometry
---

Markdown body with inline math $x^2+y^2=r^2$.

$$
\sum_{p \leq x} 1 \sim \frac{x}{\log x}
$$
```

`source.kind` says where the content comes from: `paper` or `textbook` (a citation, with the paper index slug as `paper_id` and an exact `location`; the loop asks the researcher to check the citation instead of proving it), `note` (an informal source such as a talk or lecture notes; still proved here), or `original` (produced in this project; formerly `self_proved`, which is still read). Review state and lifecycle are the separate `status` field.

An `example` may refute a result with `refutes: <asset_id>` plus `## Assumptions`, `## Calculation`, and after verification `## Verdict`; `draft` is a candidate, `approved` a researcher-confirmed counterexample (the refuted asset becomes `deprecated`), `archived` a rejected one. The loop writes these from a search candidate that passed its checks. Provable assets keep the statement above `## Proof`; the statement is frozen while a plan is executed. A `construction` whose statement lists properties as `- P1: …` is a specification: a construction search adds `## Construction` (the object) and `## Proof` below it, and neither counts as part of the statement.

A `type: candidate` file in `research/candidates/` is one object a search worker tried. Its frontmatter carries `target_asset`, a `status` (`failed`, `survived`, or `archived` once independent verification rejected it), and a `checks` map with one entry per property (`H1`, `H2`, …, `NOT` in refute mode; the specification's `P1`, `P2`, … in construct mode), each `pass`, `fail`, or `unknown`. Its body has `## Object`, `## Checks` with one `###` per property, and `## Failure` naming the first failing property. The loop stamps the round, slot, direction, and statement digest on it, so a changed statement starts the search over. Plans written after failures need `## Difference from failed plans` naming each failed plan ID and may list `## Assumed definitions`.

Only forward relations are stored (`depends_on`, `uses_definitions`, `related_assets`, `target_asset`, `inspired_by`, `refutes`). What uses a node, and which plans target an asset, are derived and shown in the dashboard. Filename IDs are unique across all research folders.

A `type: idea` file in `research/ideas/` is a freeform intuition, possible approach, gap, or test case. It uses `status: draft`, `resolved` (answered, or turned into a plan or lemma; `resolved_by` names the decision, plan, or asset), or `archived` (dropped), an `idea_kind` (`approach`, `question`, `observation`, `test_case`, or `risk`), and zero or more `related_assets`; it needs no checklist or target asset. A `type: plan` file in `research/plans/` is one proof attempt for one `target_asset`, with optional `inspired_by` idea IDs. Its body has `## Goal`, `## Plan` with ordered checkboxes (`1. [ ] ...`), and `## Verification`. Its status is `pending`, `failed` (with the obstruction under `## Failure`; one failed approach does not make the asset false), `succeeded` (the proof is in the asset and `## Outcome` says where), or `abandoned`. Plans are kept whatever their outcome, so collaborators see what was tried.

```yaml
---
type: plan
title: Prove the bound by induction
status: pending
target_asset: main_bound
inspired_by: []
tags: [induction]
---
```

A direction keeps its prose freeform and may have no related assets:

```yaml
---
type: idea
title: Explore prelimit toral collapse
status: draft
idea_kind: approach
related_assets: [cfg_nilpotent_killing_structure, local_to_global_kernel_separation]
tags: [collapse, holonomy]
---
```

Create a new proof plan when an idea becomes actionable (`research-loop idea convert`), which marks the idea resolved and keeps it. A plan can cite several origins through `inspired_by`. When the loop records a proof, it stamps the plan's `proof_digest`; the dashboard marks a succeeded plan outdated if the asset's proof is edited later. When a counterexample is confirmed, the refuted asset's pending plans become `abandoned`. Node files store only forward relations: an asset's plans, related ideas, and counterexamples are shown in the dashboard and by `research-loop show <asset>`, never written into its body. Asset approval stays a separate researcher decision.

Definitions live in `research/definitions/<id>.md`, one concept per file. A definition has `type: definition`, a title such as `Definition (subgroup)`, `status`, `depends_on` listing other definition IDs, optional source and tags, and a Markdown body with its statement and notation. A concept becomes a definition when a kept result uses it, whether it is standard or introduced by the source. That includes every definition in your own manuscript and the conditions a paper defines, such as "$f$ satisfies (H)", with one node per labelled hypothesis, so a change to a condition marks the results that assume it stale. A source's definitions that no kept result uses are skipped, and a different meaning of the same word gets a qualified ID. Remark assets hold only what defines nothing: standing assumptions, conventions, and observations. Asset `depends_on` lists assets; `uses_definitions` lists definitions. Approved definitions are the primary source for notation checks; `notations.tex` remains a supplementary LaTeX reference.

Dependency order is derived, never written into files: the Assets and Definitions panels list active nodes in `depends_on` order with their position, and titles stay as written. Missing IDs, cycles, or dependencies on deprecated or archived nodes are reported in the dashboard and the Research Assistant output. From a project root, `node .agents/skills/research-maintenance/scripts/research-maintenance.cjs validate` checks node schema, global IDs, and dependencies and prints the order.

The research folders are kept valid at three points, whoever writes the files. Before an agent writes, the PreToolUse hook denies files and folders outside the research layout, including the destinations of `mv`, `cp`, `git mv`, and `rsync`. When the agent ends its turn, the Stop hook validates the whole workspace, loop or not, and sends the agent back (at most twice) to fix problems that were not there when the turn began; this catches what scripts wrote. On commit, a git pre-commit hook that refresh installs in `.git/hooks/pre-commit` validates the staged research files against the last commit and refuses a commit that adds problems; problems already committed never block. Skip it once with `git commit --no-verify`. Refresh leaves a pre-commit hook of your own, or a `core.hooksPath` setting, untouched.

Asset and definition bodies can link verified prose mentions with ordinary relative Markdown links. For example, an asset can link the term `subgroup` to `../definitions/subgroup.md` and `Subgroup Lemma` to `./subgroup_lemma.md`. The dashboard opens these links in the corresponding node tab, and relationship ID chips are clickable. Run `research-maintenance links --preview` to inspect a backfill across assets and definitions, then `--apply` for the reviewed changes; add `--file research/assets/<id>.md` to limit a run to one node. The linker skips math, code, headings, existing links, and ambiguous matches, and reports mentions without a verified relationship ID for review. Agents run this step after creating or materially revising nodes; the extension does not rewrite body links on every file change.

Markdown can also link to a local paper PDF. From `research/assets/theorem.md`, use a Markdown link with text `source paper` and target `../../research-local/raw_papers/lang_weil.pdf` to open the PDF in VS Code's viewer when clicked in the dashboard preview. The path is relative to the Markdown file; use the configured `localSourcePdfs` folder if it differs from the default. PDFs stay local and ignored by Git. Links must point directly to a PDF in that folder; missing files show an error in the dashboard.

### Upgrading an older project

Projects written by earlier versions stored plans under ideas, definitions under assets, successful plans as `type: proof_record`, `used_in` lists, numbered titles, managed link lists inside node bodies, `source.kind: self_proved`, and required results as a `## Required Results` list in project.md. When the extension opens such a project it offers to migrate it, showing every change before writing. From the command line, commit your work, then run `research-maintenance migrate --preview` and `--apply`. The migration moves files, rewrites only the affected frontmatter lines, moves project.md's required results into `required_results` frontmatter without discarding any paragraph, and carries a still-valid project approval over; it never approves anything that was not approved. Read the `REVIEW` lines it prints, for example to confirm that each definition moved out of assets defines a concept a result uses.

## Paper format

`research/papers.md` contains one section per slug; the slug must equal the key in the configured bibliography:

```markdown
## lang_weil

- Local file: `research-local/raw_papers/lang_weil.pdf`
- Source URL: https://example.org/stable-paper-location
- SHA-256: `...`
- Description: Original Lang–Weil theorem on rational points over finite fields.
```

The local file line is shared as a convention, but the PDF itself is ignored by Git.

## AI setup

The extension installs its bundled skills to `.agents/skills/` and `.claude/skills/` and maintains a protected generated section in `AGENTS.md` (and only an `@AGENTS.md` import in a `CLAUDE.md` you keep). The twelve bundled skills are: `research-loop` (the driver), `import-math-paper`, `extract-research-nodes`, `explore-research` (find and summarize nodes), `search-object` (counterexample and construction search), `plan-proof`, `execute-proof`, `check-notation`, `research-maintenance` (validate, links, backlinks, migrate), `plan-manuscript`, `draft-latex`, and `revise-manuscript-prose`. Refresh removes installed copies of skills that earlier versions shipped and later merged. Only the bundled skill folders are ignored by the generated `.gitignore`; project skills with distinct names can be committed. Local LaTeX build instructions are in this README and the Manuscript panel. Generated guidance is ignored.

Generated instructions are deliberately compact and deterministic. They point agents to canonical node and paper files instead of duplicating every node body, reducing Git noise and merge conflicts.

Run **Research Assistant: Refresh Project Setup** after editing `.research-assistant.json` or upgrading the extension. Refresh reconciles the shared scaffold, agent instructions, local LaTeX settings, extension recommendation, output directory, file watchers, and Manuscript status without replacing existing research or TeX source files.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run watch
```

Press **F5** in VS Code to launch the Extension Development Host. The build produces `out/extension.js` and the webview bundle under `out/webview/`.
