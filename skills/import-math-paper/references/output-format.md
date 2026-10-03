# Paper import output format

Read `.research-assistant.json` first. For the default shared Overleaf layout, use:

```text
research/papers/<slug>/
  metadata.yaml
  paper.md
  figures/
```

Keep the authoritative PDF at `research-local/raw_papers/<slug>.pdf` by default. This directory is deliberately ignored by Git and may be changed in project configuration. Do not copy the PDF into the shared paper directory.

## metadata.yaml

Record at least:

```yaml
slug: example_2024
title: Example title
source_url: https://arxiv.org/abs/0000.00000
source_pdf_local: research-local/raw_papers/example_2024.pdf
markdown: paper.md
extraction:
  method: embedded-text
  generated_at: 2026-01-01T00:00:00Z
  source_sha256: "..."
  reviewed: false
  limitations: []
```

Use an honest method such as `embedded-text`, `ocr`, or `mixed`. Omit unavailable bibliographic fields rather than inventing them.

## paper.md

Start with a short provenance warning and retain page boundaries:

```markdown
> AI-generated working transcription. The PDF is authoritative.

<!-- source-page: 1 -->

# Paper title

<!-- source-page: 2 -->

## Theorem 1
...
```

Represent uncertain extraction as `[uncertain: ...]` or an HTML comment explaining the ambiguity. Do not collapse content across page markers when doing so would make provenance unclear.

## Extracted nodes

For a paper-derived node, include the existing frontmatter fields:

```yaml
status: draft
source:
  kind: paper
  paper_id: example_2024
  location: Theorem 1, pp. 2–3
```

Distinguish a faithful transcription from a paraphrase in the node body when that distinction matters.
