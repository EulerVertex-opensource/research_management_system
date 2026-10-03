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

Claude Code has the identical copy under `.claude/skills/research-loop/scripts/`. Read `.research-assistant.json` for folder paths. The MCP server `research-assistant` offers `ask_researcher`, `request_approval`, `await_answer`, `record_idea`, and `loop_status`; the VS Code extension shows its popups. In Claude Code the tools appear as `mcp__research-assistant__<tool>`; in Codex under the `research-assistant` server.

## Start, resume, pause

- Run `status --brief` first, always. It reports run status, stage, current asset and plan, parked assets, the pending question, the approval queue, and late researcher answers.
- `start --provider claude|codex [--goal "..."]` when nothing is running. `resume` when paused. If another session drives the loop, say so and stop; pass `--force` only when the researcher asks you to take over.
- `extend --goal "..."` when the project is already approved (typically at `ready`) and the researcher wants a new conjecture or end goal. It reopens `draft_project`; approved results stay approved and only the new result and its dependencies go through scaffold, falsify, plan, and prove.
- `pause` when the researcher says so; `stop` ends the run. Never delete research files.
- After an interruption, run `validate --fix`, check `git status`, and restore unintended partial edits with `git checkout -- <file>` before continuing.
- At session start, also run `sync status`. If it reports a conflict, tell the researcher and stop. If `behind` is above 0, run `sync pull` before the next stage, and read its summary to the researcher in a few lines.

## One iteration

1. `next` prints the stage, its instruction, and writes the stage's **context pack** to `.research-assistant-loop/context/current.md` (the loop picks the nodes and sections the stage needs, within a token budget). The pack is the stage's whole reading list: do not list or browse research folders. For anything missing run `show <id> [--section Heading]` (a paper slug without `--section` shows its outline) and say why.
2. Do the stage. Heavy stages (`scaffold`, `sources`, `falsify`, `verify_counterexample`, `plan`, `execute`) run in a subagent when the harness offers one: Claude Code uses the subagent `next` names (`research-worker-light` for scaffold and sources, `research-worker-deep` for the rest); Codex spawns an agent. Give the subagent only the stage, asset, plan, the stage skill, and the pack path, and require at most five lines back. Without a subagent, do the stage inline from the pack. Do not reread what the subagent read.
3. `report <outcome> --summary "<= 5 lines" [--plan ID] [--counterexample ID]`. It validates every file written during the stage against the stage rules and advances the state. If it fails, fix exactly what it lists and report again; never work around it.
4. Repeat until `next` says `waiting`, `ready`, or `paused`, or the autopilot cap pauses the loop. Then tell the researcher in three lines or fewer what is waiting on them. At `ready` after an extension, `next` names the new results; update the existing manuscript for those only.

Stage skills: `falsify-asset` for `falsify` and `verify_counterexample`; `plan-proof` for `plan`; `execute-proof` for `execute`; `extract-research-nodes`, `import-math-paper`, `research-maintenance`, and `check-notation` for `scaffold` and `sources`.

The stage instruction from `next` states that stage's file rules, and `report` enforces them; this skill does not repeat them. What holds in every stage: only the files the stage names may change, new nodes stay `draft`, a proof never changes its statement, and nothing ever sets `status: approved` or touches `approvals/`, `decisions/`, or `handoffs/` (the loop writes decisions and handoffs itself).

## Asking the researcher

- `ask_researcher({question, kind, asset_id?, options?})` opens a VS Code popup. Kinds: `goals`, `discussion`, `blocked`, `counterexample_review`. Every call returns within about 45 seconds. If `status` is `pending`, call `await_answer({id})` with the returned id until `status` is `final`. A final result is `{answered: true, text}` or `{answered: false, reason, auto_action}`.
- On `{answered: false}` continue in auto mode: `goals` proceeds only if `project.md` already has a Main Problem, otherwise `report question`; `discussion` takes the default you stated in the question (the loop records it as an idea with `idea_kind: question`); `blocked` and `counterexample_review` park the asset (`park <asset> --reason ...`) and continue with `next`.
- If the MCP tool is unavailable: on Claude Code use the built-in AskUserQuestion; on Codex run `report question --question "..."`, ask in chat, and when the researcher replies record it with `question answer --text "..."`.
- `request_approval({kind, target, summary})` never approves by itself and follows the same `pending` / `await_answer` protocol (when the researcher turned on auto mode, it may return `{answered: true, auto: true}` at once); you may instead leave it pending and continue with other work. Kinds: `project`, `asset`, `definition`, `citation`, `counterexample`; `target` is the asset or definition ID, or `project` for kind `project`. Keep working on other actionable assets; `next` reports `waiting` when nothing remains. Late answers appear at the top of your next prompt.
- Ask when goals are unclear, a statement is ambiguous, a source cannot be verified, the failed-plan limit is reached (the loop asks with a `blocked` question itself), a counterexample was verified, or an idea needs the researcher's judgment. Do not ask to confirm routine work.

## Ideas

- Any useful vague idea, yours or the researcher's, goes to `record_idea({title, body, kind, related_assets})` at once (or `idea add --kind ...`). `kind` is `approach`, `question`, `observation`, `test_case`, or `risk`. An idea is `resolved` once answered or turned into a plan or lemma (`idea resolve <id> --by <decision, plan, or asset ID>`; `idea convert` does it for plans) and `archived` when dropped; never deleted. Researcher directions and answers are decision records the loop writes; do not copy them into ideas.
- Guided idea conversation, when the researcher opens an idea or says "discuss idea X":
  1. Restate the idea and which required results it could serve; read only those assets.
  2. Decide the shape with the researcher: (a) a new approach to an existing asset, so a new plan with `inspired_by`; (b) a missing intermediate result, so a new draft lemma asset added to the `depends_on` of the result it serves (say that this re-opens that result's approval); (c) a new end goal, so `extend --goal "..."`, then a new entry under `required_results` in project.md followed by `request_approval(kind: "project")`.
  3. Draft the concrete statement and an executable checklist; confirm with `ask_researcher(kind: "discussion")`.
  4. Write the files, run `research-maintenance validate` and `links`, link plan and idea with `idea convert <ideaId> --asset ... --goal ... --steps ... --verification ...` (or, for a new lemma, `idea resolve <ideaId> --by <lemma_id>`), and `unpark` any asset the idea targets.

## Sharing with collaborators (git sync)

Research files are shared through git; the loop's run state is not. Use only the sync commands. The PreToolUse hook denies raw `git pull`, `push`, `rebase`, and `merge`.

- `sync status`: ahead/behind, uncommitted research files, unreported stage edits, the latest handoff.
- `sync pull [--remote NAME]`: only between stages (report first). It fetches, rebases or merges, validates every research file, invalidates approvals whose content or dependencies changed upstream, rebuilds parked assets, change requests, and falsification from the shared records, re-baselines the stage, and prints a research summary. On conflicts it stops and pauses the loop. **Never resolve a conflict in a statement, proof, definition, or decision yourself**: show the researcher both sides; after they resolve it and finish the rebase or merge, run `sync pull --continue`.
- If `report` says HEAD moved during the stage, run `sync pull --continue` and redo the stage. Never report files git brought in as your own.
- After project approval, scaffold, sources, each succeeded plan, and each approval the researcher tells you about, run `sync prepare` (add `--latex` when the manuscript changed). Fix every FAIL item. On success it writes a handoff; tell the researcher it is ready and that **they** publish (the "Publish Research to Collaborators" command, or `sync publish`, which asks them to confirm in VS Code). Never try to confirm a publish yourself, never push, and never rename shared files.
- `handoff --note "..."` when the researcher stops for the day, so the next collaborator knows where to continue.

## Hard rules

- Never write `status: approved`, never edit approval records. Approval happens only through the researcher's click, dashboard, or editor, or through auto mode the researcher turned on; `report` and `next` say what auto mode approved. Never read or change `.research-assistant-loop/settings.json`.
- Never invent a paper, theorem, location, proof step, or researcher answer.
- A failed plan is not a falsification. Only a verified counterexample confirmed by the researcher refutes a statement, and only the researcher deprecates an asset.
- Do not change a statement while proving it; a revised statement gets a new asset ID.
- The library (`library/<collection>/`, `lib_` IDs) holds known results the researcher approves once; the loop never falsifies or proves them. Find them with `library search <words>`. Library files may be added or edited at any stage (editing an approved one sends it back for approval); `library promote <lib_id>` copies one into the project as a variant to prove here.
- Load only the context pack and what you request with `show`; earlier stages live in the pack's report summaries, not in rereading their files.
- If you stop while the loop is running, the Stop hook asks you to continue; that is expected. It stops asking when the loop waits for the researcher, is paused, or reaches its per-session cap.
