import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { parseMarkdown } from './Frontmatter';
import { EVENTS_PATH, LoopFiles, dashboardLinkPath, isApproved, proofDigest, statementDigest, writeDashboardLinks } from './ResearchLoopModel';
import { readApprovals } from './ApprovalStore';
import { normalizeProse, sha } from '../domain/digests';
import { INACTIVE_STATUSES } from '../domain/nodeKinds';
import { requiredAssetIds } from '../domain/project';
import { listNodeFiles, locateNodeFile } from '../domain/registry';
import { sectionContent, stripManagedBlocks } from '../domain/sections';
import { ProofRevision, REVISIONS_DIR, STYLE_FILE, parseRevisionDraft, proofDraftProblem, remarksOf, revisionPath } from '../domain/revisions';
import {
  LEVEL_LABEL, STATE_LABEL, StudyInput, StudyItem, UNDERSTANDING_PATH, UnderstandingFile, UnderstandingLevel,
  isBehind, markFor, parseUnderstanding, serializeUnderstanding, studyItems, understandingParts,
} from '../domain/understanding';

/**
 * The teaching side of the research loop: which results are verified, where
 * the researcher stands on each, the material the teaching chat explains one
 * from, and the researcher's own marks. Reads the shared research files and
 * writes only the researcher's local understanding file. Must not import vscode.
 */

interface Node { id: string; file: string; raw: string; data: Record<string, any>; body: string; origin?: 'library' }

const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const strip = (text: string) => stripManagedBlocks(text).replace(/\n{3,}/g, '\n\n').trim();
/** A statement under the pack's own heading: the file's `## Statement` heading is dropped. */
const statementText = (statement: string) => strip(statement).replace(/^## Statement[ \t]*\n+/, '');
const day = (iso?: string) => iso ? iso.slice(0, 10) : '';

export interface StudyOverview { items: StudyItem[]; behind: number; lastStudied?: string }

export class Teaching {
  constructor(private readonly files: LoopFiles, private readonly paths: ProjectPaths) {}

  /** Link files written while rendering, so every link in the text opens even before the extension indexes a new node. */
  private links: Array<{ id: string; title: string; file: string }> = [];

  /** A Markdown link the researcher can click in the chat to open the node in the dashboard (see dashboardLinkPath), and its file. */
  private reference(id: string, title: string, file?: string): string {
    if (file) this.links.push({ id, title, file });
    return `[${title.replace(/[[\]]/g, '')}](${dashboardLinkPath(id)})${file ? ` (file: [${file}](${file}))` : ''}`;
  }

  private async flushLinks(): Promise<void> {
    const links = this.links;
    this.links = [];
    await writeDashboardLinks(this.files, links);
  }

  async understanding(): Promise<UnderstandingFile> {
    return parseUnderstanding(await this.files.readFile(UNDERSTANDING_PATH).catch(() => ''));
  }

  private async nodes(kind: 'asset' | 'definition'): Promise<Map<string, Node>> {
    const nodes = new Map<string, Node>();
    for (const file of await listNodeFiles(this.files, this.paths, kind)) {
      const id = path.posix.basename(file, '.md');
      if (nodes.has(id)) continue;
      const raw = await this.files.readFile(file).catch(() => undefined);
      if (raw === undefined) continue;
      try {
        const parsed = parseMarkdown(raw);
        nodes.set(id, { id, file, raw, data: parsed.data, body: parsed.content, ...(locateNodeFile(file, this.paths)?.origin === 'library' ? { origin: 'library' as const } : {}) });
      } catch { /* validate reports it */ }
    }
    return nodes;
  }

  private async plans(): Promise<Node[]> {
    const plans: Node[] = [];
    for (const file of await this.files.listFiles(this.paths.plans)) {
      const raw = await this.files.readFile(file).catch(() => undefined);
      if (raw === undefined) continue;
      try { const parsed = parseMarkdown(raw); if (parsed.data.type === 'plan') plans.push({ id: path.posix.basename(file, '.md'), file, raw, data: parsed.data, body: parsed.content }); } catch { /* skip */ }
    }
    return plans;
  }

  private async reports(): Promise<Array<Record<string, any>>> {
    const raw = await this.files.readFile(EVENTS_PATH).catch(() => '');
    return raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } }).filter((event) => event.type === 'report');
  }

  /**
   * Everything the teaching material is built from. A result counts as
   * verified when the researcher (or auto mode) approved this exact version, or
   * an independent check confirmed this exact proof of this exact statement.
   */
  private async sources() {
    const [assets, definitions, plans, approvals, project, reports] = await Promise.all([
      this.nodes('asset'), this.nodes('definition'), this.plans(), readApprovals(this.files, this.paths.researchRoot).then((file) => file.records).catch(() => []),
      this.files.readFile(this.paths.projectMd).catch(() => ''), this.reports(),
    ]);
    const required = new Set(requiredAssetIds(project));
    const inputs: StudyInput[] = [];
    const usable = (node: Node) => !node.origin && !INACTIVE_STATUSES.has(node.data.status);
    const approvedAt = (kind: 'asset' | 'definition', id: string) => approvals.find((record) => record.kind === kind && record.target === id)?.approvedAt;
    for (const node of [...assets.values()].filter(usable)) {
      const approved = node.data.status === 'approved' && isApproved(approvals, 'asset', node.id, node.raw);
      const proof = sectionContent(node.body, 'Proof').trim() ? proofDigest(node.raw) : undefined;
      const statement = statementDigest(node.raw);
      const checkedBy = proof ? plans.find((plan) => plan.data.target_asset === node.id && plan.data.status === 'succeeded'
        && plan.data.proof_digest === proof && plan.data.statement_digest === statement && plan.data.verified_proof_digest === proof) : undefined;
      if (!approved && !checkedBy) continue;
      const confirmed = checkedBy ? reports.filter((event) => event.stage === 'verify_proof' && event.outcome === 'confirmed' && event.assetId === node.id).pop()?.at : undefined;
      inputs.push({
        id: node.id, kind: 'asset', type: String(node.data.type ?? ''), title: String(node.data.title ?? node.id), raw: node.raw,
        verified: approved ? 'approved' : 'checked', prerequisites: [...list(node.data.depends_on), ...list(node.data.uses_definitions)],
        required: required.has(node.id), failedPlans: plans.filter((plan) => plan.data.target_asset === node.id && plan.data.status === 'failed').length,
        verifiedAt: (approved ? approvedAt('asset', node.id) : undefined) ?? confirmed,
      });
    }
    for (const node of [...definitions.values()].filter(usable)) {
      if (!(node.data.status === 'approved' && isApproved(approvals, 'definition', node.id, node.raw))) continue;
      inputs.push({ id: node.id, kind: 'definition', type: 'definition', title: String(node.data.title ?? node.id), raw: node.raw, verified: 'approved', prerequisites: list(node.data.depends_on), required: false, failedPlans: 0, verifiedAt: approvedAt('definition', node.id) });
    }
    return { assets, definitions, plans, required, inputs, reports };
  }

  async overview(): Promise<StudyOverview> {
    const [{ inputs }, understanding] = await Promise.all([this.sources(), this.understanding()]);
    const items = studyItems(inputs, understanding.marks);
    const times = Object.values(understanding.marks).map((mark) => mark.at).sort();
    return { items, behind: items.filter(isBehind).length, ...(times.length ? { lastStudied: times[times.length - 1] } : {}) };
  }

  /** The study list as the teaching chat reads it: what is new or changed first, in an order where each result comes after what it rests on. */
  async listText(): Promise<string> {
    const { items, behind, lastStudied } = await this.overview();
    if (!items.length) return 'No verified results yet: nothing has been approved or confirmed by an independent check. Only verified results are taught.';
    const { reports, assets, definitions } = await this.sources();
    const fileOf = (id: string) => (assets.get(id) ?? definitions.get(id))?.file;
    // What was proved, as the loop told the researcher; the check's own line when the proof came another way.
    const lastReport = (id: string) => (reports.filter((event) => event.assetId === id && event.outcome === 'proved' && event.summary).pop()
      ?? reports.filter((event) => event.assetId === id && event.outcome === 'confirmed' && event.summary).pop())?.summary as string | undefined;
    const title = new Map(items.map((item) => [item.id, item.title]));
    const line = (item: StudyItem, index: number) => [
      `${index + 1}. [${STATE_LABEL[item.state]}] ${item.title} (${item.id}): ${item.type}${item.required ? ', main result' : ''}; ${item.verified === 'approved' ? 'approved' : 'proof confirmed by an independent check'}${item.verifiedAt ? ` ${day(item.verifiedAt)}` : ''}${lastStudied && item.verifiedAt && item.verifiedAt > lastStudied ? ' (since you last studied)' : ''}.`,
      `   Aim: ${LEVEL_LABEL[item.suggested].toLowerCase()}${item.failedPlans ? ` (${item.failedPlans} failed attempt${item.failedPlans === 1 ? '' : 's'} before this proof)` : ''}.${item.waitingOn.length ? ` First: ${item.waitingOn.map((id) => title.get(id) ?? id).join(', ')}.` : ' Ready.'}`,
      ...(lastReport(item.id) ? [`   The loop said: ${lastReport(item.id)}`] : []),
      `   Link: ${this.reference(item.id, item.title, fileOf(item.id))}`,
    ].join('\n');
    const todo = items.filter(isBehind);
    const done = items.filter((item) => !isBehind(item));
    const pending = await this.pendingRevisions();
    const text = [
      `${items.length} verified result${items.length === 1 ? '' : 's'}; ${behind} new to you or changed since you studied ${behind === 1 ? 'it' : 'them'}.${lastStudied ? ` Last studied ${day(lastStudied)}.` : ''}`,
      pending.length ? `Rewordings waiting for the loop to check and apply: ${pending.map((revision) => `${title.get(revision.id) ?? revision.id} (${revision.proof ? 'proof' : ''}${revision.proof && revision.remarks !== undefined ? ' and ' : ''}${revision.remarks !== undefined ? 'remarks' : ''})`).join(', ')}.` : '',
      todo.length ? `\nTo study, in order (each after what it rests on):\n${todo.map(line).join('\n')}` : '\nNothing new: you have studied every verified result.',
      done.length ? `\nAlready understood:\n${done.map((item) => `- ${item.title} (${item.id}): ${LEVEL_LABEL[item.level!].toLowerCase()}${item.note ? `; your note: ${item.note}` : ''}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    await this.flushLinks();
    return text;
  }

  /** The material for teaching one verified result: statement and proof, what it rests on, how the proof was found, and what the researcher already knows. */
  async packText(id: string): Promise<string> {
    const { assets, definitions, plans, required, inputs, reports } = await this.sources();
    const understanding = await this.understanding();
    const items = studyItems(inputs, understanding.marks);
    const item = items.find((entry) => entry.id === id);
    if (!item) {
      const known = assets.get(id) ?? definitions.get(id);
      throw new Error(known ? `${id} is not verified yet (neither approved nor confirmed by an independent check); only verified results are taught.` : `No result or definition named ${id}.`);
    }
    const node = (item.kind === 'asset' ? assets : definitions).get(id)!;
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    const standing = (other: string) => { const entry = byId.get(other); return !entry ? 'not verified yet' : entry.level ? `researcher knows: ${LEVEL_LABEL[entry.level].toLowerCase()}` : `researcher: ${STATE_LABEL[entry.state].toLowerCase()}`; };
    const titleOf = (other: string) => String((assets.get(other) ?? definitions.get(other))?.data.title ?? other);
    const statementOf = (other: string) => { const found = assets.get(other) ?? definitions.get(other); return found ? statementText(understandingParts(found.raw).statement) : '(no file)'; };
    // Main results this one holds up, through the results that rest on it.
    const dependants = (target: string) => [...assets.values()].filter((asset) => list(asset.data.depends_on).includes(target) || list(asset.data.uses_definitions).includes(target)).map((asset) => asset.id);
    const holdsUp = new Set<string>(); const queue = [id]; const seen = new Set<string>();
    while (queue.length) { const next = queue.shift()!; if (seen.has(next)) continue; seen.add(next); if (next !== id && required.has(next)) holdsUp.add(next); queue.push(...dependants(next)); }
    const mark = understanding.marks[id];
    const parts = understandingParts(node.raw);
    const ownPlans = plans.filter((plan) => plan.data.target_asset === id);
    const proofPlan = ownPlans.find((plan) => plan.data.status === 'succeeded' && plan.data.proof_digest === parts.proofDigest);
    const failed = ownPlans.filter((plan) => plan.data.status === 'failed');
    const section = (plan: Node, heading: string) => { const text = strip(sectionContent(plan.body, heading)); return text ? `#### ${heading}\n\n${text}` : ''; };
    const ideas = await this.openIdeas(id);
    const said = reports.filter((event) => event.assetId === id && event.summary).slice(-8);
    const prerequisites = [...list(node.data.depends_on), ...list(node.data.uses_definitions)];
    const adapts = proofPlan ? list(proofPlan.data.adapts) : [];
    const blocks: string[] = [
      `# Teaching material: ${item.title} (${id})`,
      [
        `${item.type}${item.required ? ', a main result' : ''}; ${item.verified === 'approved' ? 'approved' : 'its proof was confirmed by an independent check (not yet approved by the researcher)'}${item.verifiedAt ? ` on ${day(item.verifiedAt)}` : ''}.`,
        `The researcher: ${STATE_LABEL[item.state].toLowerCase()}${item.level ? `; still knows ${LEVEL_LABEL[item.level].toLowerCase()}` : ''}. Suggested aim: ${LEVEL_LABEL[item.suggested].toLowerCase()}.`,
        mark?.note ? `The researcher's own note from last time: ${mark.note}` : '',
        holdsUp.size ? `It holds up: ${[...holdsUp].map(titleOf).join(', ')}.` : item.required ? 'It is a main result.' : 'No main result rests on it yet.',
      ].filter(Boolean).join('\n'),
      `## Statement\n\n${statementText(parts.statement)}`,
      parts.proof ? `## Proof\n\n${strip(parts.proof)}` : item.kind === 'asset' ? '## Proof\n\nNo proof in the file (a cited or supporting result).' : '',
    ];
    const remarks = remarksOf(node.body);
    if (remarks) blocks.push(`## The researcher's remarks (not part of the proof)\n\n${remarks}`);
    const pending = (await this.pendingRevisions()).find((revision) => revision.id === id);
    if (pending) blocks.push([`## A rewording waiting for the loop (proposed ${day(pending.at)})`, pending.changes ? `What changes: ${pending.changes}` : '', pending.proof ? `### Reworded proof\n\n${pending.proof}` : '', pending.remarks !== undefined ? `### Remarks\n\n${pending.remarks || '(remove the remarks)'}` : ''].filter(Boolean).join('\n\n'));
    const style = await this.styleText();
    if (style) blocks.push(`## The project's proof style (follow it when rewording)\n\n${style}`);
    if (mark && item.state === 'statement_changed') blocks.push(`## The statement the researcher studied (${day(mark.at)})\n\n${statementText(mark.snapshot.statement)}`);
    if (mark && (item.state === 'statement_changed' || item.state === 'proof_changed') && mark.snapshot.proof) blocks.push(`## The proof the researcher studied (${day(mark.at)})\n\n${strip(mark.snapshot.proof)}`);
    if (prerequisites.length) blocks.push(`## What it rests on\n\n${prerequisites.map((other) => `### ${titleOf(other)} (${other}; ${standing(other)})\n\n${statementOf(other)}`).join('\n\n')}`);
    if (proofPlan) blocks.push([`## How this proof was found (plan ${proofPlan.id})`, ...['Goal', 'Changes', 'Plan', 'Adapted from', 'Difference from failed plans', 'Verdict'].map((heading) => section(proofPlan, heading))].filter(Boolean).join('\n\n'));
    if (failed.length) blocks.push([`## Attempts that failed (${failed.length})`, ...failed.map((plan) => [`### ${String(plan.data.title ?? plan.id)} (${plan.id})`, section(plan, 'Goal'), section(plan, 'Failure'), section(plan, 'Verdict')].filter(Boolean).join('\n\n'))].join('\n\n'));
    if (adapts.length) blocks.push(`## Known results whose proof it follows\n\n${adapts.map((other) => `### ${titleOf(other)} (${other})\n\n${statementOf(other)}`).join('\n\n')}`);
    if (ideas.length) blocks.push(`## Open doubts and questions about it\n\n${ideas.map((idea) => `- ${idea.title} (${idea.id}, ${idea.kind}${idea.origin ? `, raised by the ${idea.origin}` : ''}): ${idea.summary}`).join('\n')}`);
    if (said.length) blocks.push(`## What the loop reported about it\n\n${said.map((event) => `- ${day(event.at)} ${event.stage} ${event.outcome}: ${event.summary}`).join('\n')}`);
    // Every node named above, as a link the researcher can click to read the file in the dashboard.
    const nodeLink = (other: string) => { const found = assets.get(other) ?? definitions.get(other); return `- ${this.reference(other, titleOf(other), found?.file)}`; };
    const planLink = (plan: Node) => `- ${this.reference(plan.id, `${String(plan.data.title ?? plan.id)} (${plan.data.status} plan)`, plan.file)}`;
    blocks.push(['## Links for the researcher', nodeLink(id), ...[...new Set([...prerequisites, ...adapts, ...holdsUp])].map(nodeLink), ...(proofPlan ? [planLink(proofPlan)] : []), ...failed.map(planLink),
      ...ideas.map((idea) => `- ${this.reference(idea.id, idea.title, `${this.paths.ideas}/${idea.id}.md`)}`)].join('\n'));
    await this.flushLinks();
    return blocks.filter(Boolean).join('\n\n') + '\n';
  }

  private async openIdeas(id: string): Promise<Array<{ id: string; title: string; kind: string; origin?: string; summary: string }>> {
    const ideas = [];
    for (const file of await this.files.listFiles(this.paths.ideas)) {
      const raw = await this.files.readFile(file).catch(() => '');
      let parsed;
      try { parsed = parseMarkdown(raw); } catch { continue; }
      const data = parsed.data;
      if (['resolved', 'archived'].includes(data.status) || !list(data.related_assets).includes(id)) continue;
      ideas.push({ id: path.posix.basename(file, '.md'), title: String(data.title ?? ''), kind: String(data.idea_kind ?? 'idea'), origin: typeof data.origin === 'string' ? data.origin : undefined, summary: strip(parsed.content).split('\n\n')[0].replace(/\s+/g, ' ').slice(0, 300) });
    }
    return ideas;
  }

  /** Rewordings the teaching chat proposed that the loop has not applied yet. */
  async pendingRevisions(): Promise<ProofRevision[]> {
    const revisions: ProofRevision[] = [];
    for (const file of await this.files.listFiles(REVISIONS_DIR, '.json')) {
      try { revisions.push(JSON.parse(await this.files.readFile(file)) as ProofRevision); } catch { /* the loop reports it */ }
    }
    return revisions;
  }

  /**
   * Propose a rewording of a verified result: its proof (checked independently
   * before it stands) and/or the researcher's remarks. The loop applies it
   * between stages; a newer proposal for the same result replaces this one.
   */
  async propose(id: string, draft: string, at: string): Promise<ProofRevision> {
    const parsed = parseRevisionDraft(draft);
    const { inputs } = await this.sources();
    const input = inputs.find((entry) => entry.id === id);
    if (!input) throw new Error(`${id} is not a verified result; only verified results are reworded from the teaching chat.`);
    const parts = understandingParts(input.raw);
    if (parsed.proof) {
      if (input.kind !== 'asset' || !parts.proof) throw new Error(`${id} has no proof to reword; only its remarks can change.`);
      const problem = proofDraftProblem(parsed.proof);
      if (problem) throw new Error(problem);
      if (sha(normalizeProse(parsed.proof)) === parts.proofDigest) throw new Error('The reworded proof is the same as the current one.');
    }
    const revision: ProofRevision = { id, ...parsed, baseStatement: parts.statementDigest, ...(parts.proofDigest ? { baseProof: parts.proofDigest } : {}), at };
    await this.files.writeFile(revisionPath(id), JSON.stringify(revision, null, 2) + '\n');
    return revision;
  }

  private styleFile(): string { return this.paths.researchRoot === '.' ? STYLE_FILE : `${this.paths.researchRoot}/${STYLE_FILE}`; }

  async styleText(): Promise<string> {
    return strip((await this.files.readFile(this.styleFile()).catch(() => '')).replace(/^# .*\n+/, ''));
  }

  /** Add one rule to the project's proof style (shared with collaborators), after the researcher agreed to keep it. */
  async addStyle(rule: string): Promise<string> {
    const text = rule.replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('Say the style rule to add.');
    const file = this.styleFile();
    const current = await this.files.readFile(file).catch(() => '');
    const header = '# Proof style\n\nHow proofs in this project are written, as the researchers asked. New proofs follow it, and the teaching chat rewords proofs to it. Edit freely.\n\n';
    await this.files.writeFile(file, `${(current.trim() ? current.trimEnd() + '\n' : header)}- ${text}\n`);
    return file;
  }

  /**
   * After a rewording the researcher asked for passed the check, their mark
   * moves to the new wording at the same level, since they worked it out in the
   * teaching chat. A mark that no longer held for the old proof stays as it is.
   */
  async carryMark(id: string, previousProof: string, raw: string, at: string): Promise<void> {
    const file = await this.understanding();
    const mark = file.marks[id];
    if (!mark || (mark.level !== 'black_box' && mark.proof !== previousProof) || mark.statement !== understandingParts(raw).statementDigest) return;
    file.marks[id] = markFor(raw, mark.level, at, mark.note);
    await this.files.writeFile(UNDERSTANDING_PATH, serializeUnderstanding(file));
  }

  /** Record the researcher's own judgement; `none` forgets the mark. Only verified results can be marked. */
  async mark(id: string, level: UnderstandingLevel | 'none', options: { note?: string; at: string }): Promise<StudyItem | undefined> {
    const { inputs } = await this.sources();
    const input = inputs.find((entry) => entry.id === id);
    if (!input) throw new Error(`${id} is not a verified result; only verified results can be marked as understood.`);
    const file = await this.understanding();
    if (level === 'none') delete file.marks[id];
    else file.marks[id] = markFor(input.raw, level, options.at, options.note ?? file.marks[id]?.note);
    await this.files.writeFile(UNDERSTANDING_PATH, serializeUnderstanding(file));
    return studyItems(inputs, file.marks).find((entry) => entry.id === id);
  }
}
