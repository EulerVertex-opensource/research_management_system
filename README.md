# Research Assistant — VSCode Extension

A local, file-based research management tool for mathematicians, deeply integrated with VSCode. It organizes mathematical research around structured **nodes** (theorems, lemmas, ideas, etc.) stored as plain Markdown files with YAML frontmatter, and keeps your Copilot/Claude context automatically up to date.

---

## Features

### Dashboard panels

| Panel | What it does |
|---|---|
| **Project** | Edit and preview `project.md` — your project description, goals, open questions |
| **Papers** | Browse registered papers, view/edit BibTeX + description, add PDFs |
| **Assets** | Browse and edit theorem/lemma/definition/etc. nodes |
| **Ideas** | Browse and edit idea nodes |
| **Manuscript** | Quick reference to LaTeX file locations |

### Node editor (Assets & Ideas)

- **Metadata form** with live validation:
  - *Type* — locked to `idea` for ideas; dropdown limited to asset types for assets
  - *Status* — `draft | approved | deprecated | archived`
  - *Source* — `paper` or `self_proved` only; paper_id field has autocomplete against registered papers, turns green on valid match (clickable to open PDF), red on invalid entry
  - *Depends on / Used in / Related assets* — chip-based multi-select with node search; unknown IDs shown in red
  - *Tags* — comma-separated free text
- **Markdown editor** with **Editor / Split / Preview** modes
  - Math rendered by KaTeX (HTML output with proper fonts)
  - GFM: tables and `- [ ]` / `- [x]` checklists
  - Block math requires `$$` on its own line (see [Math syntax](#math-syntax))
- **Auto-save** — changes are saved automatically 1.5 s after the last edit; manual Save button available for immediate saving
- **Resizable panes** — drag the splitter between the node list and content area; drag the splitter below the metadata form to adjust its height; all sizes persisted across sessions
- **Live sync** — external edits (e.g. from Copilot) are reflected immediately without switching panels

### Papers panel

- List of all registered papers (parsed from `papers.md` + `manuscript/reference.bib`)
- **Add PDF…** button — opens OS file picker, copies PDF to `raw_papers/`, updates `papers.md` and `reference.bib`
- Slug and BibTeX key stay in sync: editing one updates the other
- Renaming a slug renames the PDF file on disk if possible
- Paper detail view with **Editor / Preview** toggle for BibTeX entry and Markdown description
- Auto-save (1.5 s debounce)

### AI context (Copilot and Codex)

Every time any node is saved, the extension regenerates `.github/copilot-instructions.md` with:
- Full project structure reference
- Node frontmatter schema and rules
- Math and file-format conventions
- All approved nodes (with body snippets)
- Draft node list

Copilot reads this file automatically, so it understands your project structure without any extra prompting.

The extension also maintains:

- `AGENTS.md` — durable Codex guidance generated inside protected markers; text outside the markers is preserved
- `.research/workflows/` — agent-neutral workflow definitions shared by integrations
- `.agents/skills/import-math-paper/` — a Codex skill for provenance-preserving PDF-to-Markdown import

The original PDF remains authoritative. Imported Markdown is a searchable working transcription with source-page markers and an explicit review state.

---

## Getting started

1. Open any folder in VSCode as your research workspace.
2. Run the command **Research Assistant: Open Dashboard** (Ctrl+Shift+P).
3. Click **Initialize Project** in the Project panel to create the folder structure.
4. Start adding papers (Papers panel) and creating nodes (Assets / Ideas panels).

---

## Workspace structure

```
your-research-project/
  assets/               ← theorem, lemma, proposition, definition, example, construction, remark nodes
  ideas/                ← idea nodes
  raw_papers/           ← PDF source papers
  papers/               ← optional Markdown transcriptions and extraction metadata
  manuscript/
    main.tex            ← LaTeX document root
    macro.tex           ← ALL \newcommand, \DeclareMathOperator, theorem environments
    notations.tex       ← ALL notation definitions
    reference.bib       ← BibTeX bibliography
    sections/           ← one .tex file per paper section
  project.md            ← project description, goals, open questions
  papers.md             ← paper index (one ## slug section per paper)
  .github/
    copilot-instructions.md   ← auto-generated AI context (do not edit manually)
  .research/workflows/        ← generated agent-neutral workflow descriptions
  .agents/skills/             ← generated project-local Codex skills
  AGENTS.md                   ← generated Codex repository guidance plus user-authored sections
```

---

## File formats

### Asset node (`assets/<id>.md`)

```markdown
---
type: theorem          # theorem | lemma | proposition | definition | example | construction | remark
title: Chebotarev Density Theorem
status: draft          # draft | approved | deprecated | archived
source:
  kind: paper          # paper | self_proved  (only these two)
  paper_id: lang_weil  # must match a slug in papers.md
  location: Theorem 3.1
depends_on:            # ids of nodes this result relies on
  - frobenius_conjugacy_class
used_in:               # ids of nodes that use this result
  - main_counting_argument
tags:
  - arithmetic-geometry
  - finite-fields
---

Markdown body. Inline math: $x^2 + y^2 = r^2$.

Block math ($$  must be on its own line):

$$
\sum_{p \leq x} 1 \sim \frac{x}{\log x}
$$
```

### Idea node (`ideas/<id>.md`)

```markdown
---
type: idea             # always idea — do not change
title: Use Frobenius cycle type to count factorization patterns
status: draft
related_assets:
  - chebotarev_density_theorem
tags:
  - galois-theory
  - counting
---

Description of the idea, strategy, open questions…
```

### papers.md

```markdown
# Papers

## lang_weil

- File: `raw_papers/lang_weil.pdf`
- Description: Original Lang-Weil theorem on rational points over finite fields.
```

The slug (`lang_weil`) is the `paper_id` used in asset frontmatter and the BibTeX citation key.

---

## Math syntax

The Markdown renderer uses **remark-math + rehype-katex**. Block display math requires `$$` on its own line:

```
$$
ax + by + cz = 0
$$
```

Single-line `$$ax+by=0$$` is **not** parsed as display math. Inline math uses `$...$` as usual.

---

## Key rules for AI assistants

- **Source kind**: only `paper` and `self_proved` are valid — never `textbook` or `note`.
- **Idea type**: the `type` field of an idea must always remain `idea`.
- **Status after edit**: whenever you create or modify a node file, set `status: draft`. Do not promote to `approved` — that is the researcher's decision.
- **Array fields** (`depends_on`, `used_in`, `related_assets`): values must be exact node IDs (filenames without `.md`). Both block format (dashes) and flow format `[id1, id2]` are valid YAML and parsed correctly.
- **Block math**: always use the newline form shown above.
- **LaTeX**: do not introduce `\newcommand` without reading `macro.tex` first; do not change notation without reading `notations.tex` first.

---

## Tech stack

| Layer | Technology |
|---|---|
| Extension host | TypeScript, VSCode Extension API |
| Webview UI | React 18, esbuild (IIFE bundle) |
| YAML frontmatter | gray-matter |
| Markdown rendering | react-markdown, remark-gfm |
| Math rendering | remark-math, rehype-katex, KaTeX (HTML output) |
| File watching | `vscode.workspace.createFileSystemWatcher` |
| UI state persistence | `vscode.ExtensionContext.globalState` |

---

## Development

```bash
npm install
npm run build      # one-shot build
npm run watch      # rebuild on file changes
```

Press **F5** in VSCode to launch the Extension Development Host.

The build produces:
- `out/extension.js` — extension host (CommonJS)
- `out/webview/main.js` + `out/webview/main.css` — webview bundle (IIFE + KaTeX CSS + fonts)
