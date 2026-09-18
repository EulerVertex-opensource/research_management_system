---
name: import-math-paper
description: Import a mathematical paper from PDF into a page-marked Markdown working copy, preserve provenance, flag extraction uncertainty, and optionally create draft research nodes. Use when adding, transcribing, OCR-processing, or extracting results from a paper. Do not use for ordinary edits to an already imported paper.
---

# Import a mathematical paper

Create a searchable working representation without treating extraction as mathematical verification.

## Required outcome

Read `.research-assistant.json` and keep the untouched PDF in its configured `localSourcePdfs` directory. That directory is local-only and must remain ignored by Git. Produce shared metadata and Markdown in the configured research paper directory so collaborators can trace every extracted claim and retrieve the same source. Read [references/output-format.md](references/output-format.md) before creating files.

## Workflow

1. Choose a stable lowercase paper slug consistent with the BibTeX key.
2. Preserve the original PDF locally, record a stable DOI/arXiv/publisher URL when available, and compute a SHA-256 checksum when a local hashing tool is available.
3. Extract text page by page using available local PDF tools. Use OCR only for pages without a usable text layer.
4. Normalize headings, paragraphs, lists, and ordinary formulas into Markdown while retaining source-page markers.
5. Preserve uncertain text visibly. Never silently repair a formula whose intended meaning is unclear.
6. Render or inspect source pages containing important formulas, theorem statements, diagrams, tables, or suspicious extraction.
7. Record the extraction method, timestamp, checksum, review state, and known limitations in metadata.
8. If requested, extract definitions to the configured definitions folder using `extract-definitions`, and theorem-like results to assets. Set every created or materially changed node to `status: draft` and include paper slug plus page/location provenance.
9. After writing asset nodes, use the `order-assets` skill to validate dependencies and update title order.
10. Use `link-research-nodes` to link verified definition and asset mentions in created node bodies.
11. Run `check-notation` against each new or materially revised asset using its linked definitions.
12. Summarize files created, uncertain passages, visually checked pages, and work still requiring human review.

## Boundaries

- Do not alter or replace the source PDF.
- Do not add source PDFs, OCR caches, or LaTeX build output to Git.
- Do not claim that OCR accuracy establishes mathematical correctness.
- Do not mark the transcription or extracted nodes as reviewed or approved without explicit researcher confirmation.
- Prefer the Markdown for search and broad reading; return to the PDF for exact notation and citation.
- Do not install converters, OCR engines, or other dependencies without user authorization.
