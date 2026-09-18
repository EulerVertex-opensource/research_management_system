import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { AssetInput } from '../services/AssetOrder';
import { planDefinitionMigration } from '../services/DefinitionMigration';

async function readNodes(folder: string): Promise<AssetInput[]> {
  try {
    const names = (await fs.readdir(folder)).filter((name) => name.endsWith('.md')).sort();
    return Promise.all(names.map(async (name) => ({ id: name.slice(0, -3), raw: await fs.readFile(path.join(folder, name), 'utf8') })));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function inside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(root + path.sep)) throw new Error(`Research path must be inside project: ${relative}`);
  return resolved;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply && args.includes('--preview')) throw new Error('Choose --preview or --apply');
  if (args.some((arg) => !['--preview', '--apply', '--project'].includes(arg) && args[args.indexOf(arg) - 1] !== '--project')) {
    throw new Error('Usage: migrate-definitions [--preview | --apply] [--project PROJECT_ROOT]');
  }
  const projectArg = args.indexOf('--project');
  if (projectArg >= 0 && !args[projectArg + 1]) throw new Error('--project needs a path');
  const root = path.resolve(projectArg >= 0 ? args[projectArg + 1] : process.cwd());
  const config = JSON.parse(await fs.readFile(path.join(root, '.research-assistant.json'), 'utf8'));
  const research = config.research ?? {};
  const assetsFolder = inside(root, research.assets ?? (config.layout === 'legacy' ? 'assets' : 'research/assets'));
  const definitionsFolder = inside(root, research.definitions ?? (config.layout === 'legacy' ? 'definitions' : 'research/definitions'));
  const ideasFolder = inside(root, research.ideas ?? (config.layout === 'legacy' ? 'ideas' : 'research/ideas'));
  const [assets, definitions, ideas] = await Promise.all([readNodes(assetsFolder), readNodes(definitionsFolder), readNodes(ideasFolder)]);
  const plan = planDefinitionMigration(assets, definitions, ideas);
  const original = new Map(assets.map((item) => [item.id, item.raw]));
  const edited = plan.updatedAssets.filter((item) => item.raw !== original.get(item.id));
  process.stdout.write(`Move ${plan.moved.length} definition file(s); update ${edited.length} asset link file(s).\n`);
  for (const item of plan.moved) {
    process.stdout.write(`MOVE ${item.id}.md -> ${definitionsFolder}\n`);
    process.stdout.write(`REVIEW ${item.id}.md: confirm this is a commonly used definition; keep project-specific conditions or assumptions as linked remark assets\n`);
  }
  for (const item of edited) {
    const before = matter(original.get(item.id)!).data;
    const after = matter(item.raw).data;
    const oldIds = new Set(Array.isArray(before.uses_definitions) ? before.uses_definitions as string[] : []);
    const added = (Array.isArray(after.uses_definitions) ? after.uses_definitions as string[] : []).filter((id) => !oldIds.has(id));
    process.stdout.write(`LINK ${item.id}.md: ${added.join(', ')}\n`);
  }
  for (const note of plan.review) process.stdout.write(`REVIEW ${note}\n`);
  process.stdout.write(`Order changes: ${plan.assetOrder.changes.length} assets, ${plan.definitionOrder.changes.length} definitions.\n`);
  for (const change of plan.assetOrder.changes) process.stdout.write(`TITLE asset/${change.id}.md: ${change.oldTitle} -> ${change.newTitle}\n`);
  for (const change of plan.definitionOrder.changes) process.stdout.write(`TITLE definition/${change.id}.md: ${change.oldTitle} -> ${change.newTitle}\n`);
  if (!apply) return;
  await fs.mkdir(definitionsFolder, { recursive: true });
  for (const item of edited) await fs.writeFile(path.join(assetsFolder, `${item.id}.md`), item.raw);
  for (const item of plan.moved) await fs.rename(path.join(assetsFolder, `${item.id}.md`), path.join(definitionsFolder, `${item.id}.md`));
  for (const change of plan.assetOrder.changes) await fs.writeFile(path.join(assetsFolder, `${change.id}.md`), change.raw);
  for (const change of plan.definitionOrder.changes) await fs.writeFile(path.join(definitionsFolder, `${change.id}.md`), change.raw);
  process.stdout.write('Migration applied. Review the reported links before committing.\n');
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
