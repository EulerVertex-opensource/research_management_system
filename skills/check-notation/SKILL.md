---
name: check-notation
description: Review mathematical LaTeX for undefined or inconsistent notation against the project's configured notation and macro files. Use for notation audits and proposed corrections.
---

# Check notation consistency

Read `.research-assistant.json`, the requested LaTeX, every configured macro or preamble file, and the notation file when present. Compare symbol meanings and uses in context; do not treat every symbol absent from the notation file as an error when it is locally defined.

Report undefined symbols, conflicting uses of one symbol, and multiple symbols used for the same object. Give locations and concise proposed corrections or additions to the notation reference. Distinguish confirmed inconsistencies from cases that need a researcher's interpretation. If no notation file is configured, review consistency within the provided LaTeX and say so.
