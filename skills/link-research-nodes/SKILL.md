---
name: link-research-nodes
description: Add comprehensive relative Markdown links for verified definition and dependent asset mentions in research node bodies, including repeated mentions and clear aliases. Use after setting relationships or when backfilling links.
---

# Link research nodes

The configured asset and definition folders contain stable filename IDs. Asset `depends_on` names assets, asset `uses_definitions` names definitions, and definition `depends_on` names definitions. Verify a relationship before adding its ID; a matching word alone does not establish the relationship. Aim to link every clear prose reference to a verified definition or dependent asset, including repeated mentions and recognizable alternate names, while preserving the author's wording.

From the project root, preview links across existing assets and definitions, then apply the reviewed changes:

```bash
node .agents/skills/link-research-nodes/scripts/link-research-nodes.cjs --preview
node .agents/skills/link-research-nodes/scripts/link-research-nodes.cjs --apply
```

For a single node, add `--file research/assets/<id>.md` or the configured definition path. Claude Code can use the same script under `.claude/skills/link-research-nodes/scripts/`.

The command links repeated prose mentions of declared targets using relative Markdown paths. It leaves equations, code, headings, existing links, and ambiguous names unchanged. Read every `REVIEW` item, then scan the affected bodies for references the title matcher missed: aliases, plurals, abbreviated names, and clear contextual references. Verify each target, add a missing `depends_on` or `uses_definitions` ID where appropriate, and rerun the preview/apply command. Add Markdown links manually for verified wording the script still cannot match. Keep every link relative to its source file and pointing to the target's stable `.md` filename. Leave equations, code, existing links, and genuinely ambiguous references alone. Do not link speculative matches or change a node's approval status solely for adding verified links.
