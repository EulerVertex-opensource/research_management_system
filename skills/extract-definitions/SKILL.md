---
name: extract-definitions
description: Extract commonly used mathematical definitions from research assets, put project-specific conditions in linked remarks, and migrate legacy definition assets when requested.
---

# Extract definitions from research assets

Read `.research-assistant.json`, the configured assets and definitions folders, and the relevant asset bodies. Search existing definitions before creating a new file. Extract a `type: definition` node only for a concept with a commonly used mathematical meaning; use that meaning and its conventional scope. Reuse a matching definition when one exists. A condition, assumption, or specialized use introduced only for this project belongs in a separate draft `type: remark` asset, even when its source calls it a definition. If a passage mixes a common definition with project-specific conditions, split it into the common definition and a remark. If conventional usage is uncertain, report it for researcher review rather than presenting the text as a standard definition.

Use one stable, descriptive filename ID per concept, such as `subgroup.md`. Create `type: definition`, `title: Definition (subgroup)`, `status: draft`, `depends_on` with exact definition IDs, source provenance when known, and a body containing the defining statement and notation it introduces. Do not invent mathematical dependencies or claim extracted text is approved.

Give each project-specific remark its own stable ID and `type: remark`, `status: draft`, source provenance when known, and the exact condition or assumption in its body. Link the remark to any standard definitions it actually uses with `uses_definitions` and relative Markdown links. Where an originating or affected asset exists, link that asset and the remark to each other with relative Markdown links; add `depends_on` only when there is a real mathematical dependency. Preserve the author's mathematical wording and do not invent a general definition from a local convention.

Add `uses_definitions` links to assets only when the concept and definition match. Preserve approval when the only asset change is a verified link; report each such link for researcher review. Material changes to an asset's statement or proof remain draft. Use the `order-definitions` skill after adding or changing definition files, and the `check-notation` skill after materially revising an asset.

After verifying relationships, use `link-research-nodes` to preview and apply relative Markdown links in the affected asset and definition bodies. Review the full bodies and reported mentions without relationship IDs; add verified IDs and links wherever the definitions or dependent assets are discussed, including clear alternate wording the script cannot match.

For existing `type: definition` files still under assets, inspect each candidate before migration. Change project-specific conditions or assumptions to `type: remark` in the assets folder and add the verified interlinks above. Then inspect the bundled migration preview for the remaining commonly used definitions:

```bash
node .agents/skills/extract-definitions/scripts/migrate-definitions.cjs --preview
```

The preview reports file moves, explicit asset link conversions, ordering changes, and relationships needing review. After reviewing it, run the same command with `--apply` to perform the migration. The script stops on ID collisions and dependencies it cannot map safely. It does not infer links from prose; do that as a separate extraction review. Claude Code can use the identical script under `.claude/skills/extract-definitions/`.
