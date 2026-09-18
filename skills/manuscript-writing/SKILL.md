---
name: manuscript-writing
description: Maintain the shared manuscript outline and section briefs, prepare a section for drafting, and sync the marked LaTeX input block.
---

# Manuscript writing workflow

Read `.research-assistant.json`. The writing files live under the configured research root at `writing/outline.md` and `writing/sections/<id>.md`. They are distinct from mathematical proof plans. The configured LaTeX sections folder contains the canonical `<id>.tex` files.

Use stable lowercase IDs with letters, digits, underscores, or hyphens. Under `## Sections`, the outline has one numbered link per section, in presentation order: `1. [Introduction](sections/introduction.md)`. A brief has YAML frontmatter `title: Introduction` and `assets: [asset_id]`, followed by `## Purpose`, `## Subsections`, and `## Gaps`. Keep its title equal to the outline link title. List only actual research asset IDs; use the Gaps prose to discuss speculative work. A brief may have `assets: []` for exposition.

After editing a brief, run `node .agents/skills/manuscript-writing/scripts/manuscript-writing.cjs prepare <id> --preview`. It reports the small, exact context set: the brief, approved selected assets and their transitive asset and definition dependencies, manuscript preamble files, and verified BibTeX keys. It stops on unknown, unapproved, or uncited paper-source nodes. Run `prepare <id> --apply` to create a missing section TeX skeleton. It never replaces an existing section.

After section files exist, run `node .agents/skills/manuscript-writing/scripts/manuscript-writing.cjs sync --preview` to inspect the proposed `\input` order, then `sync --apply` to update only the marked block in the configured main document. For an adopted manuscript, add these two lines around the existing section inputs once:

```tex
% research-assistant:sections:start
% research-assistant:sections:end
```

The command refuses to insert markers into an adopted manuscript or sync when a section file is missing. Review the resulting Git diff and compile locally or in Overleaf.
