---
name: order-assets
description: Validate and reorder research asset titles by depends_on relationships after assets are added or changed. Use for research asset creation, dependency edits, and order review.
---

# Order research assets

The configured `research.assets` directory contains Markdown assets whose filenames are stable IDs. Set `depends_on` to exact asset IDs without `.md`. Do not rename asset files to change their order.

After creating or changing an asset, run the bundled script from the project root:

```bash
node .agents/skills/order-assets/scripts/order-assets.cjs --preview
node .agents/skills/order-assets/scripts/order-assets.cjs --apply
```

Claude Code can use the identical copy under `.claude/skills/order-assets/scripts/`. The script reads `.research-assistant.json`, checks missing, inactive, and cyclic dependencies before writing, and numbers draft and approved asset titles. Deprecated and archived assets remain unnumbered. If validation fails, correct the reported dependency and rerun preview. Check the changed titles and dependency order after apply.
