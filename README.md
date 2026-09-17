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
    assets/                        ← theorem/lemma/definition/etc. nodes
    ideas/                         ← idea nodes
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
- Authored research files: `research/project.md`, `research/papers.md`, nodes in `research/assets/` and `research/ideas/`, and metadata/transcriptions in `research/papers/`.
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
    "ideas": "research/ideas",
    "papers": "research/papers",
    "localSourcePdfs": "research-local/raw_papers"
  }
}
```

All paths must remain within the workspace. LaTeX paths are relative to `latex.projectRoot`; research paths are workspace-relative. Macro files may be an empty array and `notations` may be `null` for projects without dedicated files.

Existing workspaces using `manuscript/`, root `assets/`, root `ideas/`, and `raw_papers/` are detected as `legacy` and continue to work without moving files.

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

Overleaf still compiles the tracked source independently. Do not push `.latex-out/` or generated LaTeX files to Overleaf; Overleaf likewise [recommends excluding auxiliary and local output files](https://docs.overleaf.com/managing-projects-and-files/adding-files-to-a-project/uploading-files-to-a-project/files-that-should-not-be-included-in-a-project).

## Dashboard

| Panel | Purpose |
|---|---|
| **Project** | Edit and preview the configured project description; initialize or refresh shared setup |
| **Papers** | Edit the configured bibliography and paper index; add local PDFs plus shared source URLs |
| **Assets** | Browse and edit theorem, lemma, proposition, definition, example, construction, and remark nodes |
| **Ideas** | Browse and edit research ideas |
| **Manuscript** | Compile the configured main TeX file and read the generated PDF inside Research Assistant |

Node changes are reflected live. New or materially changed nodes remain `draft`; only a researcher should promote them to `approved`.

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

Ideas always use `type: idea` and may reference `related_assets`. Source kinds are `paper` and `self_proved`. Relationship values are exact filenames without `.md`.

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

The extension installs its bundled skills to `.agents/skills/` and `.claude/skills/` and maintains protected generated sections in `AGENTS.md` and `CLAUDE.md`. The bundled skills cover paper import, theorem extraction, section planning, LaTeX drafting, notation review, node search, and node summaries. Only the bundled skill folders are ignored by the generated `.gitignore`; project skills with distinct names can be committed. The dashboard keeps its prompt templates for in-panel chat. Local LaTeX build instructions are in this README and the Manuscript panel. Generated guidance is ignored.

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
