---
name: explore-research
description: Find the research nodes relevant to a mathematical question, or summarize selected nodes and how they relate. Use when locating existing assets, definitions, ideas, or plans, or when asked for a synthesis of what the project has established.
---

# Explore the research knowledge base

Work from a compact index before reading bodies. Nodes store only forward relations; `research-loop show <asset>` adds the derived ones (its plans with status, related ideas, counterexamples), and a succeeded plan marked outdated no longer matches the asset's current proof. `research-maintenance validate` prints assets and definitions in dependency order; frontmatter (type, status, `depends_on`, `uses_definitions`, `related_assets`, `target_asset`) gives the relations. Read a full node only when its title, tags, or relations make it a candidate, and prefer its statement or one section (`research-loop show <id> --section Heading` when the loop is installed) over the whole file.

- **Find** (a question or topic): search titles, tags, and bodies across the configured asset, definition, idea, and plan folders; inspect promising nodes and their relations. Search the library of known results too with `research-loop library search <words> [--type lemma] [--collection name]` rather than reading library folders, which can be large. Return a ranked list of exact node IDs, each with one line on why it matches.
- **Summarize** (named nodes): read the selected nodes, including status, source, and relations. Explain what each establishes and how they depend on or support one another, and name any stated gap that blocks a stronger conclusion.

In both modes keep approved results, approved definitions, drafts, library results (`lib_` IDs: known, not proved here; approved once by the researcher), plans (pending, failed, succeeded), and ideas visibly separate; an idea or a failed plan is never evidence. Cite exact node IDs so the reader can open the files. Never invent an ID or claim relevance from a filename alone.
