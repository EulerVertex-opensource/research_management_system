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
    papers.md                      ← paper index keyed by BibTeX slug
    assets/                        ← theorem/lemma/etc. nodes
    definitions/                   ← definitions and their notation
    ideas/                         ← freeform research ideas
    plans/                         ← proof plans, one per attempt (pending/failed/succeeded)
    library/<collection>/          ← known results (earlier theorems, useful papers), lib_ IDs
      assets/ definitions/        ← approved once, used as known, never re-proved; edits return them to draft
    writing/
      outline.md                  ← ordered manuscript section links
      sections/<id>.md            ← section briefs and asset IDs
    papers/<slug>/                 ← shared metadata and working transcriptions
    checks/                        ← falsification checks and object-search round summaries (obstructions, limitations)
    candidates/                    ← object-search candidates: each object tried, with a pass/fail verdict per property
    decisions/                     ← researcher directions, change requests, parked results (loop-written)
    handoffs/                      ← where each collaborator stopped and what comes next
    approvals/                     ← one approval record per approved result (extension-written)

  research-local/                  ← local only; ignored by Git
    raw_papers/                    ← authoritative source PDFs

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

Stages: `discuss_goals` → `draft_project` → `review_project` → `scaffold` → `sources` → per result `search` → (`search_summary`, `verify_counterexample`) → `plan` → `execute` → researcher approval → `ready`. A confirmed counterexample deprecates the refuted asset (the corrected statement gets a new ID) and returns to the project goals. After the failed-plan limit since the last direction the loop asks you for a direction; with none, the result is set aside, or (Fast) the agent tries one new approach of its own first. The definitions the main results' statements use are agreed before any proof work (Careful) or checked at the end (Fast); every definition must be approved before `ready`.

**How careful.** Settings → Research loop has a *Careful* / *Fast* preset over six policies, each adjustable on its own: counterexample search before proving (every result, main results only, or never), agreeing on definitions before proving, what happens downstream when a statement or definition changes (everything back to review, or *Needs re-check* marks that you clear with **Still holds**), whether the loop waits for definitions it drafted to fill a gap, what happens when a result is stuck and you give no direction, and whether unanswered questions wait for you. Careful is the default. What auto mode approves without asking, and how much effort a search spends (rounds, workers, limits), are separate settings.

**Object search.** Before a result is proved, the loop searches for a counterexample (refute mode, unless *How careful* skips it); a construction whose statement lists required properties (`- P1: …`, `- P2: …`) is searched for instead of proved (construct mode), once you approve that specification. A search runs in rounds:
- **Workers.** In each round, parallel subagents each get a different direction (small cases, degenerate cases, adapting a known construction, repairing the best near-miss, trying to prove no object exists, or one of your `test_case` ideas). Each worker writes candidates to `research/candidates/` with a verdict per property, and stops checking a candidate at its first failing property.
- **Shared memory.** Workers share only a short search board the loop compiles from the shared records: obstructions, the best near-misses, and the directions already tried. A summary stage turns each round's failures into obstructions.
- **Survivors.** A candidate that passes every check goes to a fresh, independent verifier. A verified counterexample waits for your confirmation as before. A verified construction is written into the asset as `## Construction` and `## Proof` for your approval; its specification stays as approved.
- **When nothing is found.** A refute search that finds nothing writes the falsification check and moves on to planning. A construction search that reaches its round or candidate limit since your last direction asks you for a new direction, or parks the asset.
- **Limits.** Workers per round, rounds, the candidate limit, and the board size are all in **⚙ Settings → Research loop**. The loop never repeats a search on its own: ask for one in the chat, and the agent runs `search request <asset> [--rounds N]`. Those packs also show where earlier proof attempts broke.
- **Verifiers.** Checks are written arguments today (`verifier: reasoning`); the verifier field is where code or other checkers will plug in.

Generated locally on refresh and ignored by Git: `.claude/settings.local.json` (hooks, permissions), `.mcp.json`, `.codex/hooks.json`, and `.research-assistant-loop/` (state, events, bridge). Claude Code asks once to trust the project MCP server; Codex asks once to trust the project hooks under `/hooks`. Codex reads MCP servers only from its user config, so refresh registers the bundled bridge once with `codex mcp add research-assistant`; the bridge finds the open project through `~/.research-assistant/bridges.json`, which the extension maintains while it runs. The CLI behind the skill is `node .agents/skills/research-loop/scripts/research-loop.cjs` (`status`, `start`, `next`, `report`, `validate`, `park`, `idea add|convert`, `question`, `handoff`, `search status|request`, `sync status|pull|prepare|publish`, `migrate-approvals`). On `start` and after every `sync pull`, parked assets, change requests, falsification, search progress, and failure counts are re-derived from the shared records, so a fresh clone continues where a collaborator stopped.

Claude Code and Codex use the same skills, CLI, hooks, and MCP bridge. Everything that differs between them (extension ID, chat command, `/` or `$` prefix, skill folder, hooks file, write-tool matcher, MCP registration) lives in one table, `src/services/AgentProviders.ts`. Both agents receive the same JSON hook output. Codex reads `skills/research-loop/agents/openai.yaml`, which disables implicit invocation just as `disable-model-invocation` does for Claude Code.

## Dashboard

| Panel | Purpose |
|---|---|
| **Overview** | A status card (whose turn it is, what holds the research up, what happens if you do nothing); the dependency graph read top to bottom, prerequisites above and main results below, with three views (*Why isn't it done?* per main result with finished branches folded, *Only what needs me*, *Everything*); the *Needs you* list grouped by consequence; a *What happened* timeline; paper coverage; and what a change affects |
| **Project** | Edit the project contract, with derived status (required results, open questions, manuscript sections) above it; initialize or refresh shared setup |
| **Definitions** | Browse and edit definitions and their notation, listed in dependency order |
| **Assets** | Browse and edit theorem, lemma, proposition, example, construction, and remark nodes |
| **Library** | Browse known results from earlier work and papers (`lib_` IDs), and approve them in bulk |
| **Plans** | Browse and edit proof plans, including failed and succeeded attempts |
| **Ideas** | Browse and edit freeform research ideas |
| **Papers** | Edit the configured bibliography and paper index; add local PDFs plus shared source URLs |
| **Manuscript** | Compile the configured main TeX file and read the generated PDF inside Research Assistant |
| **⟳ Refresh** | Re-read the configuration and every research file from disk and update all panels |
| **⇅ Sync** | Pull collaborators' changes and share yours (see [Collaboration practice](#collaboration-practice)) |
| **⚙ Settings** | Agent, research loop (how careful, auto mode, search and effort), sync, and context-budget settings |

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
