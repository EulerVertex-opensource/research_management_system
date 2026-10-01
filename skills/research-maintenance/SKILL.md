---
name: research-maintenance
description: Deterministic upkeep of the research knowledge base - validate node schema, global IDs, and dependencies (printing dependency order), link verified prose mentions, and migrate older projects. Use after adding or editing assets or definitions, when backfilling links, or when validate reports an older schema.
---

# Research maintenance

One script, run from the project root (Claude Code has the identical copy under `.claude/skills/research-maintenance/scripts/`):

```bash
node .agents/skills/research-maintenance/scripts/research-maintenance.cjs <command> [--preview | --apply]
```

`--preview` is the default; `--apply` writes. Fix what a command reports and rerun it rather than editing around it.

## validate

`validate [--assets | --definitions]` is read-only. It checks every node's frontmatter against the schema, that filename IDs are unique across all research folders, that `depends_on` has no missing, deprecated, archived, or cyclic target, and that ideas and plans point at existing assets and ideas (a pending plan whose target was deprecated should become `abandoned`); then it prints assets and definitions in dependency order. Run it after creating or changing assets or definitions. Dependency order is derived: never write numbers into titles and never rename files to reorder them.

Relationship fields hold exact filename IDs without `.md`, and only forward relations are stored:

- asset `depends_on` → assets; asset `uses_definitions` → definitions; definition `depends_on` → definitions;
- example `refutes` → the asset it contradicts; idea `related_assets` → assets; plan `target_asset` and `inspired_by` → one asset and idea IDs;
- a promoted asset or definition's `derived_from` → the library result it was copied from.

Library nodes (`library/<collection>/assets|definitions/`, IDs starting `lib_`) are validated and ordered together with project nodes, so a project result may depend on a library one. A library node may depend only on library nodes; `validate` reports a library ID without the prefix, a project ID with it, and a library node that depends on a project node.

"Used in", an asset's plans and ideas, and its refutations are computed from these by the dashboard and `research-loop show`; never store them in a node, and never add link lists to node bodies.

## links

`links [--file research/assets/<id>.md]` adds relative Markdown links for prose mentions of an asset's verified dependencies and definitions, including repeated mentions. It leaves equations, code, headings, existing links, and ambiguous names alone. Verify a relationship before adding its ID; a matching word does not establish one. After applying, read every `REVIEW` line and scan the affected bodies for references the title matcher missed (aliases, plurals, abbreviations, clear contextual references): add the missing `depends_on` or `uses_definitions` ID and rerun, or add the relative link by hand. Do not link speculative matches, and never change a node's status for adding links.

## migrate

`migrate [--force]` upgrades a project written by an older version in one reviewable step: definitions stored under assets move to the definitions folder, plans stored under ideas move to the plans folder, `proof_record` files become plans with `status: succeeded`, stored `used_in` lists, numbered titles, and managed link blocks are dropped, `source.kind: self_proved` becomes `original`, and project.md moves its required results into `required_results` frontmatter without discarding any text. A still-valid project approval is carried over; nothing new is approved. Preview first and read every `REVIEW` line; `--apply` refuses while research files have uncommitted changes (commit first so the migration is one diff, or pass `--force`). Report the review items to the researcher.
