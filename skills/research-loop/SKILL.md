---
name: research-loop
description: Drive the human-in-the-loop mathematical research loop from the chat window (goals, project.md, asset scaffold, sources, falsify, plan, prove, researcher approval, manuscript readiness). Use when the researcher says start, resume, continue, pause, or status for the research loop, or wants to turn an idea into results and plans.
disable-model-invocation: true
---

# Research loop driver

You are the driver, not the sole mathematician. Files are the state; the bundled CLI is the state machine and validator:

```bash
node .agents/skills/research-loop/scripts/research-loop.cjs <command>
```

Claude Code has the identical copy under `.claude/skills/research-loop/scripts/`. Read `.research-assistant.json` for folder paths. The MCP server `research-assistant` offers `ask_researcher`, `request_approval`, `record_idea`, and `loop_status`; the VS Code extension shows its popups.

## Start, resume, pause

- Run `status --brief` first, always. It reports run status, stage, current asset and plan, parked assets, the pending question, the approval queue, and late researcher answers.
- `start --provider claude|codex [--goal "..."]` when nothing is running. `resume` when paused. If another session drives the loop, say so and stop; pass `--force` only when the researcher asks you to take over.
- `extend --goal "..."` when the project is already approved (typically at `ready`) and the researcher wants a new conjecture or end goal. It reopens `draft_project`; approved results stay approved and only the new result and its dependencies go through scaffold, falsify, plan, and prove.
- `pause` when the researcher says so; `stop` ends the run. Never delete research files.
- After an interruption, run `validate --fix`, check `git status`, and restore unintended partial edits with `git checkout -- <file>` before continuing.

## One iteration

1. `next` prints the stage and its instruction. Read only the files it names.
2. Do the stage. Heavy stages (`scaffold`, `sources`, `falsify`, `verify_counterexample`, `plan`, `execute`) run in a subagent when the harness offers one (Claude Code: the Agent tool with the stage skill; Codex: spawn an agent). Give the subagent only the brief from `next` and the skill name, and require a short summary back. Without a subagent, do the stage inline.
3. `report <outcome> --summary "<= 5 lines" [--plan ID] [--counterexample ID]`. It validates every file written during the stage against the stage rules and advances the state. If it fails, fix exactly what it lists and report again; never work around it.
4. Repeat until `next` says `waiting`, `ready`, or `paused`, or the autopilot cap pauses the loop. Then tell the researcher in three lines or fewer what is waiting on them. At `ready` after an extension, `next` names the new results; update the existing manuscript for those only.

Stage skills: `falsify-asset` for `falsify` and `verify_counterexample`; `prove-asset` for `plan` and `execute`. `scaffold` and `sources` use `extract-theorems`, `extract-definitions`, `import-math-paper`, `order-assets`, `order-definitions`, `link-research-nodes`, and `check-notation`.

Rules the validator enforces:

- `draft_project`: only `project.md`; `## Required Results` lists one bullet per stable snake_case asset ID (`- id: role`). When extending, keep every existing bullet and add at least one new ID.
- `scaffold`, `sources`: only new draft assets and definitions, plus appended paper index and BibTeX entries. A paper-sourced node needs `paper_id` and an exact location; a new paper needs a stable URL and a BibTeX entry. Unverifiable sources are never cited.
- `falsify`: one new draft `example` with `refutes: <asset>`, `## Assumptions`, `## Calculation`.
- `plan`: one new `pending` plan, or execute an existing pending plan first. With failed plans present, `## Difference from failed plans` names every failed plan ID.
- `execute`: only the plan file and the target asset's `## Proof`. The statement is frozen.
- Nothing ever sets `status: approved` or touches `approvals.json`.

## Asking the researcher

- `ask_researcher({question, kind, asset_id?, options?, wait_seconds?})` opens a VS Code popup and waits. Kinds: `goals`, `discussion`, `blocked`, `counterexample_review`. Result `{answered: true, text}` or `{answered: false, reason}`.
- On `{answered: false}` continue in auto mode: `goals` proceeds only if `project.md` already has a Main Problem, otherwise `report question`; `discussion` takes the default you stated in the question and records it with `record_idea` tagged `open-question`; `blocked` and `counterexample_review` park the asset (`park <asset> --reason ...`) and continue with `next`.
- If the MCP tool is unavailable: on Claude Code use the built-in AskUserQuestion; on Codex run `report question --question "..."`, ask in chat, and when the researcher replies record it with `question answer --text "..."`.
- `request_approval({kind, target, summary})` never blocks and never approves. Kinds: `project`, `asset`, `definition`, `citation`, `counterexample`. Keep working on other actionable assets; `next` reports `waiting` when nothing remains. Late answers appear at the top of your next prompt.
- Ask when goals are unclear, a statement is ambiguous, a source cannot be verified, three approaches failed, a counterexample was verified, or an idea needs the researcher's judgment. Do not ask to confirm routine work.

## Ideas

- Any useful vague idea, yours or the researcher's, goes to `record_idea({title, body, related_assets})` at once (or `idea add`). Ideas are archived, never deleted.
- Guided idea conversation, when the researcher opens an idea or says "discuss idea X":
  1. Restate the idea and which required results it could serve; read only those assets.
  2. Decide the shape with the researcher: (a) a new approach to an existing asset, so a new plan with `inspired_by`; (b) a missing intermediate result, so a new draft lemma asset added to the `depends_on` of the result it serves (say that this re-opens that result's approval); (c) a new end goal, so `extend --goal "..."`, then a new bullet under `## Required Results` followed by `request_approval(kind: "project")`.
  3. Draft the concrete statement and an executable checklist; confirm with `ask_researcher(kind: "discussion")`.
  4. Write the files, run `order-assets` and `link-research-nodes`, link plan and idea with `idea convert <ideaId> --asset ... --goal ... --steps ... --verification ...`, and `unpark` any asset the idea targets.

## Commit points

After project approval, scaffold, sources, each proof record, and each approval the researcher tells you about, run `git status` and offer a commit of the research root. Never push and never rename shared files.

## Hard rules

- Never write `status: approved`, never edit `approvals.json`. Approval happens only through the researcher's click, dashboard, or editor.
- Never invent a paper, theorem, location, proof step, or researcher answer.
- A failed plan is not a falsification. Only a verified counterexample confirmed by the researcher refutes a statement, and only the researcher deprecates an asset.
- Do not change a statement while proving it; a revised statement gets a new asset ID.
- Load only the files the stage brief names.
- If you stop while the loop is running, the Stop hook asks you to continue; that is expected. It stops asking when the loop waits for the researcher, is paused, or reaches its per-session cap.
