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
    project.md                     ← problem, goals, known results, open questions
    papers.md                      ← paper index keyed by BibTeX slug
    assets/                        ← theorem/lemma/etc. nodes
    definitions/                   ← definitions and their notation
    ideas/                         ← freeform research ideas
    plans/                         ← executable plans and proof records
    writing/
      outline.md                  ← ordered manuscript section links
      sections/<id>.md            ← section briefs and asset IDs
    papers/<slug>/                 ← shared metadata and working transcriptions

  research-local/                  ← local only; ignored by Git
    raw_papers/                    ← authoritative source PDFs

  .latex-out/                     ← local PDF and LaTeX build artifacts; ignored

  .research-assistant.json         ← committed path configuration
  .gitignore                       ← committed local/generated-file exclusions
  .vscode/                         ← generated local build settings/recommendations
  .github/copilot-instructions.md  ← generated local Copilot guidance
  .agents/skills/                  ← bundled Codex skills local; project skills shared
  .claude/skills/                  ← bundled Claude skills local; project skills shared
  AGENTS.md, CLAUDE.md             ← generated local agent guidance
```

Overleaf should compile the existing root document exactly as before. Research Assistant does not insert inputs into an adopted manuscript or replace its bibliography.

## What is shared

Commit these files:

- LaTeX, BibTeX, figures required by the manuscript, and project-specific class/style files.
- `.research-assistant.json` and the managed `.gitignore`.
- Authored research files: `research/project.md`, `research/papers.md`, nodes in `research/assets/`, `research/definitions/`, `research/ideas/`, and `research/plans/`, writing plans in `research/writing/`, and metadata/transcriptions in `research/papers/`.
- Project skills under `.agents/skills/` or `.claude/skills/` whose names do not match an extension-bundled skill.

Do not normally commit:

- `research-local/raw_papers/*.pdf`.
- OCR caches or extraction scratch files.
- Python bytecode caches (`__pycache__/`, `*.pyc`).
- LaTeX output such as `.aux`, `.log`, `.fls`, `.fdb_latexmk`, `.synctex.gz`, and `.toc` files.
- A compiled copy of the manuscript PDF.
- Everything under `.latex-out/`.
- Extension-bundled skill folders under `.agents/skills/` and `.claude/skills/`, `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, and generated `.vscode` settings/recommendations.

The generated `.gitignore` names each extension-bundled skill folder separately. On refresh, it replaces the former broad `.agents/skills/` and `.claude/skills/` ignore rules, so other skill folders can be added to Git. Bundled skill names are reserved because refresh updates those folders. Ignore rules do not remove files Git already tracks. For an existing project, review tracked generated files and remove only those from the Git index with `git rm --cached` (or `git rm -r --cached` for generated directories), then commit that change. Their local copies remain. Keep `.research-assistant.json`, TeX/BibTeX, authored research context, and project skills tracked. Refresh no longer creates `research/workflows/` or ignores its files; existing workflow files remain in place and can be reviewed for removal or tracking.

`AGENTS.md` and `CLAUDE.md` are ignored by default even though refresh preserves local text outside the generated markers. Put guidance that must reach every collaborator in tracked `research/project.md`, or explicitly force-track a custom instruction file after deciding that its generated section will change on refresh.

For each paper, share a stable DOI, arXiv, or publisher URL and a checksum when available. This lets collaborators retrieve and verify the same authoritative PDF without storing large binaries in the Overleaf repository.

## Collaboration practice

Overleaf Git supports a single remote `master` history. Pull before beginning local work and once more before pushing:

```bash
git pull --rebase origin master
# edit in VS Code / Research Assistant
git add .
git commit -m "Add research context for theorem X"
git pull --rebase origin master
git push origin HEAD:master
```

Prefer one node per file so independent results merge cleanly. Avoid renaming files that have active Overleaf comments or tracked changes, because a Git-side rename is represented as delete-and-create by Overleaf.

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
```

Use `plan-manuscript` with a researcher to decide the section order, then `plan-section` to refine one brief. The agents begin with a compact node index and read full content only for selected results. To validate a brief and list the exact approved assets, dependency definitions, preamble files, and BibTeX keys needed for drafting, run:

```bash
node .agents/skills/manuscript-writing/scripts/manuscript-writing.cjs prepare main_result --preview
node .agents/skills/manuscript-writing/scripts/manuscript-writing.cjs prepare main_result --apply
```

`--apply` creates `sections/main_result.tex` only if it is missing. The `draft-latex` skill replaces that untouched skeleton with a first draft and thereafter edits only requested passages. It marks uses of research nodes with `% [node_id]` comments; printed references use normal LaTeX labels and verified bibliography keys. Unknown or unapproved dependencies stop preparation.

When every listed TeX section exists, preview and apply the main document's input order:

```bash
node .agents/skills/manuscript-writing/scripts/manuscript-writing.cjs sync --preview
node .agents/skills/manuscript-writing/scripts/manuscript-writing.cjs sync --apply
```

For a new document, Research Assistant creates the input markers in `main.tex`. In an adopted document, place `% research-assistant:sections:start` and `% research-assistant:sections:end` on their own lines around the section inputs once. The command changes only the text between them; it refuses to guess an insertion point in an existing manuscript. Review the Git diff and compile after syncing. Use Git changes for coauthor review; [Overleaf warns](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/advanced-git-operations) that Git pushes can displace comments and tracked changes.

## Dashboard

| Panel | Purpose |
|---|---|
| **Project** | Edit and preview the configured project description; initialize or refresh shared setup |
| **Papers** | Edit the configured bibliography and paper index; add local PDFs plus shared source URLs |
| **Assets** | Browse and edit theorem, lemma, proposition, example, construction, and remark nodes |
| **Definitions** | Browse and edit dependency ordered definitions and their notation |
| **Ideas** | Browse and edit freeform research ideas |
| **Plans** | Browse and edit executable proof plans and retained proof records |
| **Manuscript** | Compile the configured main TeX file and read the generated PDF inside Research Assistant |

Node changes are reflected live. New or materially changed assets and definitions remain `draft`; only a researcher should promote them to `approved`. New directions start `draft`, and new proof plans start `pending`.

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
used_in:
  - main_counting_argument
tags:
  - arithmetic-geometry
---

Markdown body with inline math $x^2+y^2=r^2$.

$$
\sum_{p \leq x} 1 \sim \frac{x}{\log x}
$$
```

A `type: idea` file in `research/ideas/` is a freeform intuition, possible approach, gap, or test case. It uses `status: draft` or `archived` and can name zero or more `related_assets`; it needs no checklist or target asset. A `type: plan` file in `research/plans/` uses `status: pending` or `failed`, one `target_asset`, and optional `inspired_by` idea IDs. Its body has `## Goal`, `## Plan` with ordered checkboxes (`1. [ ] ...`), and `## Verification`; a failed plan also explains the obstruction under `## Failure`. Failure of one approach does not declare the asset false.

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
related_assets: [cfg_nilpotent_killing_structure, local_to_global_kernel_separation]
tags: [collapse, holonomy]
---
```

Create a new proof plan when an idea becomes actionable; keep the original idea. The plan can cite several origins through `inspired_by`. Assets list pending and failed proof plans, proof records, and draft and archived ideas separately. Ideas get a managed Markdown list linking back to their related assets, and plans link to their target and inspiring ideas. When a plan succeeds, incorporate its proof in the asset and change the retained plan file to status-free `type: proof_record` with an `## Outcome`, preserving its target and origins. Asset approval is a separate researcher decision.

Use the bundled `convert-proof-ideas` skill to classify legacy files conservatively and preserve their mathematical content. Existing files with `target_asset` and `pending` or `failed` status are recognized as plans before conversion. After refreshing project setup, preview the folder migration with `node .agents/skills/convert-proof-ideas/scripts/migrate-idea-plans.cjs --preview`, then run it with `--apply` after reviewing the moves. It converts legacy types, moves plans into the configured plans folder, rebases relative Markdown links, and rebuilds managed sections. To refresh links later, use `node .agents/skills/convert-proof-ideas/scripts/sync-proof-ideas.cjs --apply`. The extension also updates managed links when idea or plan files change.

Definitions live in `research/definitions/<id>.md`, one commonly used concept per file. A definition has `type: definition`, a title such as `001. Definition (subgroup)`, `status`, `depends_on` listing other definition IDs, optional source and tags, and a Markdown body with its statement and notation. Project-specific conditions and assumptions belong in draft `remark` assets with verified relative Markdown links to relevant definitions and assets. Split passages that contain both a common definition and a local condition. Asset `depends_on` lists assets; `uses_definitions` lists definitions. Approved definitions are the primary source for notation checks; `notations.tex` remains a supplementary LaTeX reference.

Definition titles are reordered when definition files change. After refreshing project setup, use `node .agents/skills/order-definitions/scripts/order-definitions.cjs --definitions --preview` to inspect their dependency order and `--apply` to update titles manually.

Asset and definition bodies can link verified prose mentions with ordinary relative Markdown links. For example, an asset can link the term `subgroup` to `../definitions/subgroup.md` and `Subgroup Lemma` to `./subgroup_lemma.md`. The dashboard opens these links in the corresponding node tab, and relationship ID chips are clickable. After refreshing project setup, run `node .agents/skills/link-research-nodes/scripts/link-research-nodes.cjs --preview` to inspect a backfill across assets and definitions, then use `--apply` for the reviewed changes. Add `--file research/assets/<id>.md` to limit a run to one node. The linker skips math, code, headings, existing links, and ambiguous matches; it reports mentions without a verified relationship ID for review. Agents run this step after creating or materially revising nodes. The extension does not rewrite body links on every file change.

Markdown can also link to a local paper PDF. From `research/assets/theorem.md`, use a Markdown link with text `source paper` and target `../../research-local/raw_papers/lang_weil.pdf` to open the PDF in VS Code's viewer when clicked in the dashboard preview. The path is relative to the Markdown file; use the configured `localSourcePdfs` folder if it differs from the default. PDFs stay local and ignored by Git. Links must point directly to a PDF in that folder; missing files show an error in the dashboard.

After refreshing project setup, inspect older `type: definition` files under assets and reclassify project-specific conditions or assumptions as linked remarks. Then preview migration of the remaining commonly used definitions with `node .agents/skills/extract-definitions/scripts/migrate-definitions.cjs --preview`. Inspect the reported moves, converted links, and review items, then run `--apply`. The command preserves approval status and stops on collisions or dependencies it cannot map safely. New extracted definitions start as drafts. Agents run `check-notation` when they create or materially revise assets; ordinary dashboard edits do not launch an automatic language model review.

Draft and approved asset titles are numbered in dependency order using `depends_on` (for example, `001. Chebotarev Density Theorem`). Filenames remain stable IDs. The Assets panel displays numbered results in that order, and the extension watches asset files after VS Code startup, including when the dashboard is closed. Missing IDs, cycles, or dependencies on deprecated or archived assets stop ordering and are reported in the Research Assistant output. To preview or apply the same ordering from a project root, use `node .agents/skills/order-assets/scripts/order-assets.cjs --preview` or `--apply` after refreshing agent setup. The script reads the configured asset path from `.research-assistant.json`.

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

The extension installs its bundled skills to `.agents/skills/` and `.claude/skills/` and maintains protected generated sections in `AGENTS.md` and `CLAUDE.md`. The bundled skills cover paper import, theorem and definition extraction, asset and definition ordering, proof idea conversion, research node interlinks, manuscript and section planning, writing sync, LaTeX drafting, notation review, node search, and node summaries. Only the bundled skill folders are ignored by the generated `.gitignore`; project skills with distinct names can be committed. The dashboard keeps its prompt templates for in-panel chat. Local LaTeX build instructions are in this README and the Manuscript panel. Generated guidance is ignored.

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
