---
name: order-definitions
description: Validate definition dependencies and number definition titles in a Research Assistant project. Use after creating, moving, or editing definition files.
---

# Order definitions

Read `.research-assistant.json` for the configured definitions folder. Each definition has a stable filename ID, `type: definition`, a `status`, and `depends_on` listing exact definition IDs without `.md`.

Preview the dependency order, then apply it:

```bash
node .agents/skills/order-definitions/scripts/order-definitions.cjs --definitions --preview
node .agents/skills/order-definitions/scripts/order-definitions.cjs --definitions --apply
```

Claude Code can use the identical script under `.claude/skills/order-definitions/`. The script numbers draft and approved titles as `001. Definition (subgroup)` while keeping filenames stable. It stops before writing if a dependency is missing, inactive, or cyclic. Correct the reported links and rerun preview before applying.
