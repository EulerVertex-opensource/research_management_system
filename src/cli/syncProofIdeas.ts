import * as fs from 'fs';
import * as path from 'path';
import { planProofIdeaLinks, ProofIdeaFile } from '../services/ProofIdeas';

const args = process.argv.slice(2);
const root = path.resolve(args.includes('--project') ? args[args.indexOf('--project') + 1] : process.cwd());
const apply = args.includes('--apply');
if (args.some((arg) => arg.startsWith('--') && !['--project', '--preview', '--apply'].includes(arg))) throw new Error('Unknown option');
const config = JSON.parse(fs.readFileSync(path.join(root, '.research-assistant.json'), 'utf8'));
const fallback = (name: string) => config.layout === 'legacy' ? name : `research/${name}`;
const assetFolder = config.research?.assets ?? fallback('assets');
const ideaFolder = config.research?.ideas ?? fallback('ideas');
const planFolder = config.research?.plans ?? path.posix.join(path.posix.dirname(ideaFolder), 'plans');
function readFolder(folder: string): ProofIdeaFile[] {
  const directory = path.join(root, folder);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.md')).map((name) => {
    const filePath = path.posix.join(folder.replace(/\\/g, '/'), name);
    return { filePath, raw: fs.readFileSync(path.join(directory, name), 'utf8') };
  });
}
const plan = planProofIdeaLinks(readFolder(assetFolder), [...readFolder(ideaFolder), ...readFolder(planFolder)]);
for (const issue of plan.issues) console.error(`REVIEW ${issue}`);
for (const change of plan.changes) console.log(`${apply ? 'UPDATE' : 'PREVIEW'} ${change.filePath}`);
if (apply) for (const change of plan.changes) fs.writeFileSync(path.join(root, change.filePath), change.after);
console.log(`${apply ? plan.changes.length : 0} file(s) updated`);
