# Research Assistant — VS Code Extension

A file-based mathematical research workspace designed to live inside an Overleaf Git project. LaTeX, research nodes, paper metadata, and AI instructions are shared through Git; original source PDFs and reproducible build output stay local.

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
5. Review and commit the added scaffold, then push it to Overleaf.
6. Collaborators clone the same project, open it in VS Code, and run Research Assistant. The committed `.research-assistant.json` makes every installation use the same paths and context.

Initialization discovers an existing root-level `.tex` file containing `\documentclass`, preferring `main.tex`, and discovers common BibTeX, preamble, macro, and notation files. Existing files are never overwritten. Edit `.research-assistant.json` if the detected layout needs adjustment, then run **Research Assistant: Refresh Agent Setup**.

## Shared workspace structure

```text
overleaf-project/
  main.tex                         ← existing Overleaf main document
  sections/                        ← manuscript sections, when used
  figures/                         ← manuscript figures
  macros.tex                       ← optional; discovered/configured
  notations.tex                    ← optional; discovered/configured
  references.bib                   ← discovered/configured bibliography

  research/                        ← shared, canonical AI/research context
    README.md
    project.md                     ← problem, goals, known results, open questions
    papers.md                      ← paper index keyed by BibTeX slug
    assets/                        ← theorem/lemma/definition/etc. nodes
    ideas/                         ← idea nodes
    papers/<slug>/                 ← shared metadata and working transcriptions
    workflows/                     ← agent-neutral workflow instructions

  research-local/                  ← local only; ignored by Git
    raw_papers/                    ← authoritative source PDFs

  .research-assistant.json         ← committed path configuration
  .github/copilot-instructions.md  ← compact deterministic Copilot guidance
  .agents/skills/                  ← project-local Codex skills
  .claude/skills/                  ← project-local Claude Code skills
  AGENTS.md                        ← generated section plus preserved user text
  CLAUDE.md                        ← generated section plus preserved user text
  .gitignore                       ← includes managed local/build exclusions
```

Overleaf should compile the existing root document exactly as before. Research Assistant does not insert inputs into an adopted manuscript or replace its bibliography.

## What is shared

Commit these files:

- LaTeX, BibTeX, figures required by the manuscript, and project-specific class/style files.
- `.research-assistant.json`.
- `research/**/*.md`, `research/**/*.yaml`, and other lightweight research metadata.
- `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, agent skills, and workflows.

Do not normally commit:

- `research-local/raw_papers/*.pdf`.
- OCR caches or extraction scratch files.
- LaTeX output such as `.aux`, `.log`, `.fls`, `.fdb_latexmk`, `.synctex.gz`, and `.toc` files.
- A compiled copy of the manuscript PDF.

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
    "workflows": "research/workflows",
    "localSourcePdfs": "research-local/raw_papers"
  }
}
```

All paths must remain within the workspace. LaTeX paths are relative to `latex.projectRoot`; research paths are workspace-relative. Macro files may be an empty array and `notations` may be `null` for projects without dedicated files.

Existing workspaces using `manuscript/`, root `assets/`, root `ideas/`, and `raw_papers/` are detected as `legacy` and continue to work without moving files.

## Dashboard

| Panel | Purpose |
|---|---|
| **Project** | Edit and preview the configured project description; initialize or refresh shared setup |
| **Papers** | Edit the configured bibliography and paper index; add local PDFs plus shared source URLs |
| **Assets** | Browse and edit theorem, lemma, proposition, definition, example, construction, and remark nodes |
| **Ideas** | Browse and edit research ideas |
| **Manuscript** | Display the configured main, bibliography, macros, notation, and section paths |

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

The extension installs its bundled skills to `.agents/skills/` and `.claude/skills/`, writes workflows under `research/workflows/`, and maintains protected generated sections in `AGENTS.md` and `CLAUDE.md`. Text outside the protected markers is preserved.

Generated instructions are deliberately compact and deterministic. They point agents to canonical node and paper files instead of duplicating every node body, reducing Git noise and merge conflicts.

Run **Research Assistant: Refresh Agent Setup** after editing `.research-assistant.json` or upgrading the extension.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run watch
```

Press **F5** in VS Code to launch the Extension Development Host. The build produces `out/extension.js` and the webview bundle under `out/webview/`.
