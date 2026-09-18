---
name: convert-proof-ideas
description: Separate freeform ideas from executable proof plans, migrate legacy files safely, and synchronize their Markdown links with assets.
---

# Organize research ideas

Read `.research-assistant.json` for the configured `ideas`, `plans`, and `assets` folders. Read each idea and the assets named in its metadata. Preserve mathematical content and stable filename IDs. Never invent a proof step, target theorem, or failure reason.

## Classify existing ideas

- Use `type: idea` in the configured ideas folder, with `status: draft | archived`, for an intuition, possible approach, gap, or test case. Keep its freeform body. `related_assets` may contain zero or more verified asset IDs. The prelimit toral collapse note belongs here: its several assets provide context, and no single asset is forced into `target_asset`.
- Use `type: plan` in the configured plans folder, with `status: pending | failed`, only when the file identifies one existing `target_asset` and has a concrete ordered checkbox plan. Its body has `## Goal`, `## Plan`, and `## Verification`. A failed plan also needs `## Failure` with a mathematical obstruction. Legacy `type: idea` files with `target_asset` and `pending` or `failed` are plans, even without `kind`.
- If an existing note is vague but mentions a possible target, keep it as an idea. Put only verified associations in `related_assets`. Report unclear asset IDs or unsupported statuses for researcher review.

When an idea yields an actionable approach, create a **new** plan file with `inspired_by: [idea_id]` (or several idea IDs), one target asset, and real steps. Keep the original idea. An idea can inspire multiple plans.

## Link and retain outcomes

From the project root, run `node .agents/skills/convert-proof-ideas/scripts/migrate-idea-plans.cjs --preview`. Review every move and any reported uncertain metadata. Run the same command with `--apply` after resolving review items. It moves existing plans and proof records out of ideas, converts legacy type and kind metadata, rebases ordinary relative Markdown links, and rebuilds managed sections. It refuses filename collisions. Claude Code can use the identical script under `.claude/skills/convert-proof-ideas/scripts/`.

For later link updates, run `node .agents/skills/convert-proof-ideas/scripts/sync-proof-ideas.cjs --preview`, inspect proposed changes and review items, then use `--apply`. Assets list pending and failed plans, proof records, and draft and archived ideas; ideas link back to related assets; plans link to target assets and inspiring ideas. Repeated synchronization leaves current files unchanged.

When a plan succeeds, put the proof in the asset first. Retain the plan file in the plans folder as `type: proof_record`, remove `status`, preserve `target_asset` and `inspired_by`, and add `## Outcome` explaining where the proof was incorporated. Asset approval remains a researcher decision.
