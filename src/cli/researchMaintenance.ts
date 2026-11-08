import * as path from 'path';
import { NodeLoopFiles, findProjectRoot, loadProjectPaths } from './nodeFiles';
import { NodeGitRunner } from './nodeGit';
import { parseMarkdown } from '../services/Frontmatter';
import { computeAssetOrder } from '../services/AssetOrder';
import { planResearchInterlinks } from '../services/ResearchInterlinks';
import { ideaPlanProblems } from '../services/ProofIdeas';
import { OverlayFiles, RemarkMigrationPlan, migrateProject, migrationReasons } from '../services/SchemaMigration';
import * as fs from 'fs/promises';
import { NodeKind, nodeKindOf } from '../domain/nodeKinds';
import { Remarks } from '../services/Remarks';
import { remarkReferenceProblems } from '../domain/remarks';
import { duplicateIds, nodeProblems } from '../domain/schema';
import { ProjectPaths } from '../models/types';
import { RegistryNode, libraryProblems, nodeFolders } from '../domain/registry';
import { layoutReport } from '../domain/layout';
import { packageProblemsIn } from '../services/PackageService';
import { collectionProblemsIn } from '../services/CollectionService';

const USAGE = `Usage: research-maintenance <command> [--preview | --apply] [--project ROOT]

  validate [--assets | --definitions]  Check node schema, global IDs, dependencies, and the research folder layout; print dependency order. Read-only.
  links [--file NODE_PATH]             Link verified prose mentions of dependencies and definitions in asset and definition bodies.
  migrate [--force] [--remarks FILE]   Upgrade an older project to the current schema (definitions, plans, project.md, titles, link blocks, source kinds, remarks).
                                       FILE sorts the remark assets: {"<id>": {"as": "assumption|convention|lemma|proposition|example|remark", "target": "<id for a remark>"}}.

--preview (default) prints the changes; --apply writes them.`;

interface Options { command: string; apply: boolean; root: string; file?: string; only?: 'asset' | 'definition'; force: boolean; remarks?: string }

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
  if (!['validate', 'links', 'migrate'].includes(command)) throw new Error(`Unknown command ${command}.\n${USAGE}`);
  const options: Options = { command, apply: false, root: '', force: false };
  let project: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const value = () => { const next = rest[++index]; if (!next) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--preview') options.apply = false;
    else if (arg === '--project') project = value();
    else if (arg === '--file' && command === 'links') options.file = value().replace(/\\/g, '/').replace(/^\.\//, '');
    else if (arg === '--assets' && command === 'validate') options.only = 'asset';
    else if (arg === '--definitions' && command === 'validate') options.only = 'definition';
    else if (arg === '--force' && command === 'migrate') options.force = true;
    else if (arg === '--remarks' && command === 'migrate') options.remarks = path.resolve(value());
    else throw new Error(`Unknown option ${arg} for ${command}.\n${USAGE}`);
  }
  if (rest.includes('--apply') && rest.includes('--preview')) throw new Error('Choose --preview or --apply');
  const root = project ? path.resolve(project) : findProjectRoot(process.cwd());
  if (!root) throw new Error('No .research-assistant.json found here or in a parent folder; pass --project ROOT.');
  options.root = root;
  return options;
}

const out = (line: string) => process.stdout.write(`${line}\n`);

async function readFolder(files: NodeLoopFiles, folder: string) {
  return Promise.all((await files.listFiles(folder)).map(async (file) => ({ filePath: file, raw: await files.readFile(file) })));
}

/** Project and library nodes of one kind. */
async function readNodes(files: NodeLoopFiles, paths: ProjectPaths, kind: 'asset' | 'definition') {
  const result: Array<{ filePath: string; raw: string }> = [];
  for (const folder of await nodeFolders(files, paths, kind)) result.push(...await readFolder(files, folder));
  return result;
}

async function validate(files: NodeLoopFiles, paths: ProjectPaths, only?: 'asset' | 'definition'): Promise<number> {
  const problems: string[] = [];
  const index = await files.readFile(paths.paperIndex).catch(() => '');
  const paperIds = new Set([...index.matchAll(/^##\s+([a-z][a-z0-9_]*)\s*$/gm)].map((match) => match[1]));
  const folders: Array<[NodeKind, string]> = [['asset', paths.assets], ['definition', paths.definitions], ['idea', paths.ideas], ['plan', paths.plans]];
  for (const kind of ['asset', 'definition'] as const) for (const folder of (await nodeFolders(files, paths, kind)).slice(1)) folders.push([kind, folder]);
  const all: string[] = [];
  const registry: RegistryNode[] = [];
  for (const [kind, folder] of folders) {
    for (const { filePath, raw } of await readFolder(files, folder)) {
      all.push(filePath);
      try {
        const { data, content } = parseMarkdown(raw);
        const id = path.posix.basename(filePath, '.md');
        registry.push({ id, file: filePath, data });
        problems.push(...nodeProblems(kind, id, data, content, { allowApproved: true, paperIds }).map((problem) => `${filePath}: ${problem.slice(id.length + 2)}`));
      } catch (error) { problems.push(`${filePath}: invalid YAML (${String(error)})`); }
    }
  }
  problems.push(...duplicateIds(all));
  problems.push(...libraryProblems(registry, paths));
  // Imported packages: vendored files unedited and complete (see domain/packages.ts).
  problems.push(...await packageProblemsIn(files, paths));
  // Collections from papers and notes: collection.md well formed, a paper collection's results cite that paper.
  problems.push(...await collectionProblemsIn(files, paths));
  problems.push(...ideaPlanProblems(await readFolder(files, paths.assets), [...await readFolder(files, paths.ideas), ...await readFolder(files, paths.plans)]));
  for (const [kind, label] of [['asset', 'Assets'], ['definition', 'Definitions']] as const) {
    if (only && only !== kind) continue;
    const nodes = await readNodes(files, paths, kind);
    try {
      const { order } = computeAssetOrder(nodes.map(({ filePath, raw }) => ({ id: path.posix.basename(filePath, '.md'), raw })), kind);
      const titles = new Map(nodes.map(({ filePath, raw }) => [path.posix.basename(filePath, '.md'), String(parseMarkdown(raw).data.title ?? '')]));
      out(`${label} in dependency order:`);
      const width = Math.max(3, String(order.length).length);
      order.forEach((id, position) => out(`  ${String(position + 1).padStart(width, '0')} ${id} — ${titles.get(id)}`));
    } catch (error) { problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const layout = await layoutReport(files, paths);
  problems.push(...layout.problems);
  {
    const remarks = new Remarks(files, paths);
    const ids = new Set((await remarks.all()).map((remark) => remark.id));
    problems.push(...await remarks.problems(new Set(registry.filter((node) => ['asset', 'definition'].includes(String(nodeKindOf(node.data.type)))).map((node) => node.id))));
    if (ids.size) for (const node of registry) problems.push(...remarkReferenceProblems(node.file, node.data, ids));
  }
  for (const file of layout.legacy) out(`NOTE ${file} is left from an older version; review it and remove it or move its content into the research folders.`);
  const reasons = await migrationReasons(files, paths);
  if (reasons.length) out(`NOTE this project uses an older schema (${reasons.join('; ')}); run \`research-maintenance migrate --preview\`.`);
  for (const problem of problems) out(`PROBLEM ${problem}`);
  out(`${problems.length} problem(s).`);
  return problems.length ? 1 : 0;
}

async function links(files: NodeLoopFiles, paths: ProjectPaths, apply: boolean, requested?: string): Promise<void> {
  const inputs = [...await readNodes(files, paths, 'asset'), ...await readNodes(files, paths, 'definition')];
  if (requested && !inputs.some((item) => item.filePath === requested)) throw new Error(`Node file not found in assets, definitions, or the library: ${requested}`);
  const plan = planResearchInterlinks(inputs, paths.assets, paths.definitions, paths.library);
  const changes = requested ? plan.changes.filter((item) => item.filePath === requested) : plan.changes;
  const issues = requested ? plan.issues.filter((item) => item.filePath === requested) : plan.issues;
  const original = new Map(inputs.map((item) => [item.filePath, item.raw]));
  for (const change of changes) {
    out(`LINK ${change.filePath}: ${change.links} occurrence(s)`);
    const before = original.get(change.filePath)!.split('\n');
    const after = change.raw.split('\n');
    for (let line = 0; line < after.length; line++) {
      if (before[line] === after[line]) continue;
      out(`  ${line + 1} - ${before[line] ?? ''}`);
      out(`  ${line + 1} + ${after[line]}`);
    }
  }
  for (const issue of issues) out(`REVIEW ${issue.filePath}:${issue.line}: ${issue.kind}: ${issue.text}`);
  out(`${changes.length} file(s)${apply ? ' updated' : ' proposed'}; ${issues.length} review item(s).`);
  if (apply) for (const change of changes) await files.writeFile(change.filePath, change.raw);
}

async function migrate(files: NodeLoopFiles, paths: ProjectPaths, root: string, apply: boolean, force: boolean, remarksFile?: string): Promise<void> {
  const reasons = await migrationReasons(files, paths);
  if (!reasons.length) { out('The project already uses the current schema; nothing to migrate.'); return; }
  out(`Migrating: ${reasons.join('; ')}.`);
  if (apply && !force) {
    const research = [paths.projectMd, paths.assets, paths.definitions, paths.ideas, paths.plans, paths.remarks, `${paths.researchRoot}/approvals`];
    const status = await new NodeGitRunner(root).run(['status', '--porcelain', '--', ...research]);
    if (status.code === 0 && status.stdout.trim()) throw new Error(`Commit or stash research changes first so the migration can be reviewed as one diff (or pass --force):\n${status.stdout.trimEnd()}`);
  }
  const overlay = new OverlayFiles(files);
  let remarkPlan: RemarkMigrationPlan | undefined;
  if (remarksFile) {
    try { remarkPlan = JSON.parse(await fs.readFile(remarksFile, 'utf8')) as RemarkMigrationPlan; } catch (error) { throw new Error(`Cannot read the remark sorting ${remarksFile}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const report = await migrateProject(overlay, paths, { remarkPlan });
  const changes = await overlay.changes();
  for (const change of changes) out(`${change.after === null ? 'DELETE' : change.before === undefined ? 'CREATE' : 'UPDATE'} ${change.file}`);
  for (const note of report.notes) out(`NOTE ${note}`);
  for (const item of report.review) out(`REVIEW ${item}`);
  if (apply) await overlay.flush();
  out(`${changes.length} file change(s)${apply ? ' applied; review them with git diff before committing' : ' proposed; rerun with --apply to write them'}.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const files = new NodeLoopFiles(options.root);
  const paths = await loadProjectPaths(options.root);
  if (options.command === 'validate') process.exitCode = await validate(files, paths, options.only);
  else if (options.command === 'links') await links(files, paths, options.apply, options.file);
  else await migrate(files, paths, options.root, options.apply, options.force, options.remarks);
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
