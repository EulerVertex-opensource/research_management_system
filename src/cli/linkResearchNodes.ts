import * as fs from 'fs/promises';
import * as path from 'path';
import { InterlinkInput, planResearchInterlinks } from '../services/ResearchInterlinks';

function projectFolder(root: string, value: unknown, fallback: string): string {
  const folder = path.resolve(root, typeof value === 'string' && value.trim() ? value : fallback);
  if (folder === root || !folder.startsWith(root + path.sep)) throw new Error(`Research path must be inside the project: ${String(value)}`);
  return folder;
}

async function readNodes(root: string, folder: string): Promise<InterlinkInput[]> {
  try {
    const names = (await fs.readdir(path.join(root, folder))).filter((name) => name.endsWith('.md')).sort();
    return Promise.all(names.map(async (name) => ({
      filePath: path.posix.join(folder, name),
      raw: await fs.readFile(path.join(root, folder, name), 'utf8'),
    })));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply && args.includes('--preview')) throw new Error('Choose --preview or --apply');
  const projectIndex = args.indexOf('--project');
  const fileIndex = args.indexOf('--file');
  if ((projectIndex >= 0 && !args[projectIndex + 1]) || (fileIndex >= 0 && !args[fileIndex + 1])) throw new Error('--project and --file need values');
  if (args.some((arg, index) => !['--apply', '--preview', '--project', '--file'].includes(arg) && args[index - 1] !== '--project' && args[index - 1] !== '--file')) {
    throw new Error('Usage: link-research-nodes [--preview | --apply] [--project ROOT] [--file RELATIVE_NODE_PATH]');
  }
  const root = path.resolve(projectIndex >= 0 ? args[projectIndex + 1] : process.cwd());
  const config = JSON.parse(await fs.readFile(path.join(root, '.research-assistant.json'), 'utf8'));
  const legacy = config.layout === 'legacy';
  const assetFolder = projectFolder(root, config.research?.assets, legacy ? 'assets' : 'research/assets');
  const definitionFolder = projectFolder(root, config.research?.definitions, legacy ? 'definitions' : 'research/definitions');
  const assets = path.relative(root, assetFolder).split(path.sep).join('/');
  const definitions = path.relative(root, definitionFolder).split(path.sep).join('/');
  const inputs = [...await readNodes(root, assets), ...await readNodes(root, definitions)];
  const plan = planResearchInterlinks(inputs, assets, definitions);
  const requested = fileIndex >= 0 ? args[fileIndex + 1].replace(/\\/g, '/').replace(/^\.\//, '') : undefined;
  if (requested && !inputs.some((item) => item.filePath === requested)) throw new Error(`Node file not found in assets or definitions: ${requested}`);
  const changes = requested ? plan.changes.filter((item) => item.filePath === requested) : plan.changes;
  const issues = requested ? plan.issues.filter((item) => item.filePath === requested) : plan.issues;
  const original = new Map(inputs.map((item) => [item.filePath, item.raw]));
  for (const change of changes) {
    process.stdout.write(`LINK ${change.filePath}: ${change.links} occurrence(s)\n`);
    const before = original.get(change.filePath)!.split('\n');
    const after = change.raw.split('\n');
    for (let line = 0; line < after.length; line++) {
      if (before[line] !== after[line]) {
        process.stdout.write(`  ${line + 1} - ${before[line] ?? ''}\n`);
        process.stdout.write(`  ${line + 1} + ${after[line]}\n`);
      }
    }
  }
  for (const issue of issues) process.stdout.write(`REVIEW ${issue.filePath}:${issue.line}: ${issue.kind}: ${issue.text}\n`);
  process.stdout.write(`${changes.length} file(s)${apply ? ' updated' : ' proposed'}; ${issues.length} review item(s).\n`);
  if (apply) for (const change of changes) await fs.writeFile(path.join(root, change.filePath), change.raw);
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
