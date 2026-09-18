---
name: extract-definitions
description: Extract reusable mathematical definitions from research assets, favor standard definitions over narrow asset-specific variants, link verified uses, and migrate legacy definition assets when requested.
---

# Extract definitions from research assets

Read `.research-assistant.json`, the configured assets and definitions folders, and the relevant asset bodies. Search existing definitions before creating a new file. When an extracted concept matches a well-known mathematical definition, use its standard meaning and conventional scope. Reuse a matching library definition when one exists; otherwise write the standard definition in a new draft file. Keep extra hypotheses, special cases, and conditions from a particular theorem or proof in that asset rather than narrowing the reusable definition. Create a distinct specialized definition only when it names a genuinely different concept, and state how it relates to the standard one. If the match or accepted meaning is uncertain, flag it for researcher review rather than silently changing the concept.

Use one stable, descriptive filename ID per concept, such as `subgroup.md`. Create `type: definition`, `title: Definition (subgroup)`, `status: draft`, `depends_on` with exact definition IDs, source provenance when known, and a body containing the defining statement and notation it introduces. Do not invent mathematical dependencies or claim extracted text is approved.

Add `uses_definitions` links to assets only when the concept and definition match. Preserve approval when the only asset change is a verified link; report each such link for researcher review. Material changes to an asset's statement or proof remain draft. Use the `order-definitions` skill after adding or changing definition files, and the `check-notation` skill after materially revising an asset.

After verifying relationships, use `link-research-nodes` to preview and apply relative Markdown links in the affected asset and definition bodies. Review the full bodies and reported mentions without relationship IDs; add verified IDs and links wherever the definitions or dependent assets are discussed, including clear alternate wording the script cannot match.

For existing `type: definition` files still under assets, first inspect the bundled migration preview:

```bash
node .agents/skills/extract-definitions/scripts/migrate-definitions.cjs --preview
```

The preview reports file moves, explicit asset link conversions, ordering changes, and relationships needing review. After reviewing it, run the same command with `--apply` to perform the migration. The script stops on ID collisions and dependencies it cannot map safely. It does not infer links from prose; do that as a separate extraction review. Claude Code can use the identical script under `.claude/skills/extract-definitions/`.
