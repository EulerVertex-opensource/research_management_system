import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { computeAssetOrder } from '../services/AssetOrder';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const definitions = args.includes('--definitions');
  if (args.some((arg) => !['--apply', '--preview', '--project', '--definitions'].includes(arg) && args[args.indexOf(arg) - 1] !== '--project')) {
    throw new Error('Usage: order-assets [--preview | --apply] [--definitions] [--project PROJECT_ROOT]');
  }
  if (apply && args.includes('--preview')) throw new Error('Choose --preview or --apply');
  const projectArg = args.indexOf('--project');
  if (projectArg >= 0 && !args[projectArg + 1]) throw new Error('--project needs a path');
  const root = path.resolve(projectArg >= 0 ? args[projectArg + 1] : process.cwd());
  const config = JSON.parse(await fs.readFile(path.join(root, '.research-assistant.json'), 'utf8'));
  const relative = definitions ? config?.research?.definitions ?? (config?.layout === 'legacy' ? 'definitions' : 'research/definitions') : config?.research?.assets;
  if (typeof relative !== 'string' || !relative.trim()) throw new Error('Configured research folder path is missing');
  const folder = path.resolve(root, relative);
  if (folder === root || !folder.startsWith(root + path.sep)) throw new Error('Research folder must be inside the project');
  const files = (await fs.readdir(folder)).filter((file) => file.endsWith('.md')).sort();
  const inputs = await Promise.all(files.map(async (file) => ({ id: file.slice(0, -3), raw: await fs.readFile(path.join(folder, file), 'utf8') })));
  const result = computeAssetOrder(inputs, definitions ? 'definition' : 'asset');
  const originalTitles = new Map(inputs.map((item) => [item.id, matter(item.raw).data.title as string]));
  for (const id of result.order) {
    const change = result.changes.find((item) => item.id === id);
    process.stdout.write(`${change?.newTitle ?? originalTitles.get(id)} [${id}]${change ? ' *' : ''}\n`);
  }
  process.stdout.write(`${result.changes.length} title change(s)${apply ? ' applied' : ' proposed'}\n`);
  if (apply) {
    for (const change of result.changes) await fs.writeFile(path.join(folder, `${change.id}.md`), change.raw);
  }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
