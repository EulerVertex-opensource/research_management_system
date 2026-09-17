---
name: find-relevant
description: Find research nodes relevant to a mathematical question and explain their relationship to it. Use when locating existing assets or ideas in the project knowledge base.
---

# Find relevant research nodes

Read `.research-assistant.json` for the configured asset and idea paths. Search node titles, tags, and bodies for the user's question, then inspect promising files and their relationships. Return a ranked list of exact node IDs with a short explanation of each match and its status. Distinguish approved results from drafts and speculative ideas. Do not invent node IDs or claim relevance based only on a filename.
