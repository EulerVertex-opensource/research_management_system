---
name: plan-section
description: Plan a mathematical manuscript section from approved research nodes and relevant ideas. Use for section outlines, result ordering, and identifying missing arguments.
---

# Plan a manuscript section

Read `.research-assistant.json`, the configured project description, and the writing outline. Work on one section brief under `writing/sections/<id>.md` at a time. Find candidate nodes from IDs, titles, status, and dependencies, then read full files only for relevant nodes. Read relevant freeform ideas and pending proof plans as possible approaches, keeping them distinct from established results. Treat failed plans as recorded obstructions.

Write or revise the brief with YAML `title` and `assets` (stable, verified IDs), followed by `## Purpose`, `## Subsections`, and `## Gaps`. Keep its title equal to the outline link title. Give subsection goals, result order, and exact IDs used. Record draft nodes and speculative ideas in Gaps; never present them as proved facts. If there are too few approved results, say what is missing. Do not edit the TeX section during planning.
