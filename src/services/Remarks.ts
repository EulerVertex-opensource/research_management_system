import * as crypto from 'crypto';
import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { parseMarkdown, stringifyMarkdown } from './Frontmatter';
import { LoopFiles, isApproved } from './ResearchLoopModel';
import { readApprovals } from './ApprovalStore';
import { findNodeFile } from '../domain/registry';
import {
  LOOP_REMARKS_PER_STAGE, REMARK_FROM_LIST, REMARK_ID, REMARK_ORIGIN_LIST, Remark, RemarkData, RemarkFrom, RemarkOrigin,
  remarkEditProblem, remarkProblems, remarkTargetDigest,
} from '../domain/remarks';

/** What the loop is doing, as far as a remark it writes is concerned. */
export interface LoopPosition { running: boolean; assetId?: string; stageStartedAt?: string }

export interface RemarkInput {
  target: string;
  title: string;
  body: string;
  origin: RemarkOrigin;
  from: RemarkFrom;
  anchor?: string;
  tags?: string[];
}

/** `approved`: the researcher agreed this exact text may appear in the paper. */
export interface ListedRemark extends Remark { stale: boolean; approved: boolean }

/**
 * Reads and writes remarks (see domain/remarks.ts). Every write goes through
 * here, so a remark always names a real target and is stamped with the text it
 * was written for. Remarks live outside the loop's change set: writing one
 * never disturbs a running stage.
 */
export class Remarks {
  constructor(private readonly files: LoopFiles, private readonly paths: ProjectPaths) {}

  private file(id: string): string { return `${this.paths.remarks}/${id}.md`; }

  /** The target's file, project or library; undefined when no asset or definition has this ID. */
  private async targetFile(target: string): Promise<string | undefined> {
    return (await findNodeFile(this.files, this.paths, 'asset', target)) ?? (await findNodeFile(this.files, this.paths, 'definition', target));
  }

  private async digestOf(target: string): Promise<string> {
    const file = await this.targetFile(target);
    if (!file) throw new Error(`No asset or definition named ${target}; a remark annotates an existing result or definition.`);
    return remarkTargetDigest(parseMarkdown(await this.files.readFile(file)).content);
  }

  async all(): Promise<Remark[]> {
    const remarks: Remark[] = [];
    for (const file of await this.files.listFiles(this.paths.remarks, '.md')) {
      const id = path.posix.basename(file, '.md');
      let parsed;
      try { parsed = parseMarkdown(await this.files.readFile(file)); } catch { continue; }
      if (parsed.data.type !== 'remark') continue;
      remarks.push({ ...(parsed.data as RemarkData), id, body: parsed.content.trim(), file });
    }
    return remarks.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  async get(id: string): Promise<Remark> {
    const found = (await this.all()).find((remark) => remark.id === id);
    if (!found) throw new Error(`No remark named ${id}.`);
    return found;
  }

  /** The remarks on one target (or every target), each marked stale when the target changed since it was written. */
  async list(options: { target?: string; includeArchived?: boolean } = {}): Promise<ListedRemark[]> {
    const digests = new Map<string, string | undefined>();
    const records = (await readApprovals(this.files, this.paths.researchRoot).catch(() => ({ records: [] }))).records;
    const result: ListedRemark[] = [];
    for (const remark of await this.all()) {
      if (options.target && remark.target !== options.target) continue;
      if (!options.includeArchived && remark.status === 'archived') continue;
      if (!digests.has(remark.target)) digests.set(remark.target, await this.digestOf(remark.target).catch(() => undefined));
      const current = digests.get(remark.target);
      const raw = await this.files.readFile(remark.file).catch(() => '');
      result.push({ ...remark, stale: current !== undefined && current !== remark.target_digest, approved: Boolean(raw) && isApproved(records, 'remark', remark.id, raw) });
    }
    return result;
  }

  /**
   * Add a remark. The loop writes only on the result it is working on, and at
   * most LOOP_REMARKS_PER_STAGE per stage.
   */
  async add(input: RemarkInput, options: { at: string; loop?: LoopPosition }): Promise<Remark> {
    const title = input.title.replace(/\s+/g, ' ').trim();
    const body = input.body.trim();
    if (!body) throw new Error('Say the remark: its body is empty.');
    if (!(REMARK_ORIGIN_LIST as readonly string[]).includes(input.origin)) throw new Error(`origin must be ${REMARK_ORIGIN_LIST.join(' or ')}: whose remark it is.`);
    if (!(REMARK_FROM_LIST as readonly string[]).includes(input.from)) throw new Error(`from must be one of ${REMARK_FROM_LIST.join(', ')}.`);
    if (input.from === 'loop') {
      const loop = options.loop;
      if (!loop?.running || !loop.assetId) throw new Error('The loop writes remarks only while it works on a result.');
      if (input.target !== loop.assetId) throw new Error(`The loop writes remarks only on the result it is working on (${loop.assetId}), not ${input.target}.`);
      const since = loop.stageStartedAt ?? '';
      const written = (await this.all()).filter((remark) => remark.from === 'loop' && remark.target === input.target && String(remark.at) >= since).length;
      if (written >= LOOP_REMARKS_PER_STAGE) throw new Error(`This stage already wrote ${written} remarks on ${input.target}; at most ${LOOP_REMARKS_PER_STAGE}. Keep the ones that explain the most.`);
    }
    const id = `remark_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const data: RemarkData = {
      type: 'remark', title: title || 'Remark', target: input.target, ...(input.anchor?.trim() ? { anchor: input.anchor.trim() } : {}),
      origin: input.origin, from: input.from, status: 'active', target_digest: await this.digestOf(input.target), at: options.at,
      ...(input.tags?.length ? { tags: input.tags } : {}),
    };
    await this.write(id, data, body);
    return { ...data, id, body, file: this.file(id) };
  }

  /** A light edit: the remark now speaks to the target's current text. */
  async edit(id: string, changes: { title?: string; body?: string; anchor?: string }, by: RemarkFrom, at: string): Promise<Remark> {
    const remark = await this.get(id);
    const problem = remarkEditProblem(remark, by, id);
    if (problem) throw new Error(problem);
    const body = changes.body !== undefined ? changes.body.trim() : remark.body;
    if (!body) throw new Error('A remark cannot be emptied; archive it instead.');
    const { id: _id, body: _body, file: _file, ...data } = remark;
    const next: RemarkData = {
      ...data,
      ...(changes.title !== undefined ? { title: changes.title.replace(/\s+/g, ' ').trim() || data.title } : {}),
      ...(changes.anchor !== undefined ? { anchor: changes.anchor.trim() || undefined } : {}),
      target_digest: await this.digestOf(remark.target), edited_at: at,
    } as RemarkData;
    if (!next.anchor) delete next.anchor;
    await this.write(id, next, body);
    return { ...next, id, body, file: this.file(id) };
  }

  /** Archived remarks are kept (git keeps the history) but no longer shown or offered to the paper. */
  async archive(id: string, by: RemarkFrom, at: string): Promise<Remark> {
    const remark = await this.get(id);
    const problem = remarkEditProblem(remark, by, id);
    if (problem) throw new Error(problem);
    const { id: _id, body, file: _file, ...data } = remark;
    const next = { ...data, status: 'archived', archived_at: at } as RemarkData;
    await this.write(id, next, body);
    return { ...next, id, body, file: this.file(id) };
  }

  /** Every problem with the remark files, given all asset and definition IDs. */
  async problems(targets: ReadonlySet<string>): Promise<string[]> {
    const problems: string[] = [];
    for (const file of await this.files.listFiles(this.paths.remarks, '.md')) {
      const id = path.posix.basename(file, '.md');
      try {
        const parsed = parseMarkdown(await this.files.readFile(file));
        problems.push(...remarkProblems(id, parsed.data, parsed.content, targets).map((problem) => `${this.paths.remarks}/${problem}`));
      } catch (error) {
        problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return problems;
  }

  private async write(id: string, data: RemarkData, body: string): Promise<void> {
    if (!REMARK_ID.test(id)) throw new Error(`Invalid remark ID ${id}.`);
    await this.files.writeFile(this.file(id), stringifyMarkdown(`\n${body}\n`, data as unknown as Record<string, unknown>));
  }
}
