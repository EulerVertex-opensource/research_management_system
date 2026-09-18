import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { planProofIdeaLinks, ProofIdeaFile, resolveIdeaType } from '../services/ProofIdeas';

const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith('--') && !['--project', '--preview', '--apply'].includes(arg))) throw new Error('Unknown option');
const root = path.resolve(args.includes('--project') ? args[args.indexOf('--project') + 1] : process.cwd());
const apply = args.includes('--apply');
const config = JSON.parse(fs.readFileSync(path.join(root, '.research-assistant.json'), 'utf8'));
const fallback = (name: string) => config.layout === 'legacy' ? name : `research/${name}`;
const assetsPath = config.research?.assets ?? fallback('assets');
const ideasPath = config.research?.ideas ?? fallback('ideas');
const plansPath = config.research?.plans ?? path.posix.join(path.posix.dirname(ideasPath), 'plans');
const definitionsPath = config.research?.definitions ?? fallback('definitions');

function read(folder: string): ProofIdeaFile[] {
  const dir = path.join(root, folder);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => ({
    filePath: path.posix.join(folder, name), raw: fs.readFileSync(path.join(dir, name), 'utf8'),
  }));
}

const originals = [...read(assetsPath), ...read(definitionsPath), ...read(ideasPath), ...read(plansPath)];
const moves = new Map<string, string>();
const issues: string[] = [];
for (const file of originals.filter((item) => item.filePath.startsWith(`${ideasPath}/`))) {
  try {
    const data = matter(file.raw).data;
    if (data.type === 'proof_record' || resolveIdeaType(data) === 'plan') {
      const destination = path.posix.join(plansPath, path.posix.basename(file.filePath));
      if (originals.some((item) => item.filePath === destination)) issues.push(`${file.filePath}: destination exists: ${destination}`);
      else moves.set(file.filePath, destination);
    } else if (data.type !== 'idea' || resolveIdeaType(data) !== 'idea') {
      issues.push(`${file.filePath}: unsupported or uncertain idea metadata`);
    }
  } catch { issues.push(`${file.filePath}: invalid YAML`); }
}
if (issues.length) {
  for (const issue of issues) console.error(`REVIEW ${issue}`);
  process.exitCode = 1;
} else {
  // Rebase ordinary Markdown links using their original source and destination.
  // Managed sections are rebuilt below after every move.
  const prepared = originals.map((file) => {
    const nextPath = moves.get(file.filePath) ?? file.filePath;
    const parsed = matter(file.raw);
    const data = { ...parsed.data };
    if (moves.has(file.filePath)) {
      if (resolveIdeaType(data) === 'plan') data.type = 'plan';
      delete data.kind;
    } else if (data.type === 'idea' && data.kind === 'direction') delete data.kind;
    const body = parsed.content.replace(/(\[[^\]\n]+\]\()([^\)\n]+)(\))/g, (full, open: string, href: string, close: string) => {
      if (/^(?:[a-z]+:|#|\/)/i.test(href)) return full;
      const [target, suffix = ''] = href.split(/(?=[#?])/u, 2);
      const oldTarget = path.posix.normalize(path.posix.join(path.posix.dirname(file.filePath), target));
      const newTarget = moves.get(oldTarget) ?? oldTarget;
      if (nextPath === file.filePath && newTarget === oldTarget) return full;
      const relative = path.posix.relative(path.posix.dirname(nextPath), newTarget);
      return `${open}${relative.startsWith('.') ? relative : `./${relative}`}${suffix}${close}`;
    });
    const changedMetadata = data.type !== parsed.data.type || data.kind !== parsed.data.kind;
    return { filePath: nextPath, raw: changedMetadata ? matter.stringify(body, data) : file.raw.replace(parsed.content, body) };
  });
  const assets = prepared.filter((item) => item.filePath.startsWith(`${assetsPath}/`));
  const ideaPlans = prepared.filter((item) => item.filePath.startsWith(`${ideasPath}/`) || item.filePath.startsWith(`${plansPath}/`));
  const linkPlan = planProofIdeaLinks(assets, ideaPlans);
  for (const issue of linkPlan.issues) console.error(`REVIEW ${issue}`);
  const final = new Map(prepared.map((file) => [file.filePath, file.raw]));
  for (const change of linkPlan.changes) final.set(change.filePath, change.after);
  const changes = originals.map((file) => ({ from: file.filePath, to: moves.get(file.filePath) ?? file.filePath, before: file.raw,
    after: final.get(moves.get(file.filePath) ?? file.filePath)! })).filter((item) => item.from !== item.to || item.before !== item.after);
  for (const change of changes) console.log(`${apply ? 'UPDATE' : 'PREVIEW'} ${change.from}${change.from === change.to ? '' : ` -> ${change.to}`}`);
  if (apply) {
    fs.mkdirSync(path.join(root, plansPath), { recursive: true });
    for (const change of changes) {
      fs.writeFileSync(path.join(root, change.to), change.after);
      if (change.from !== change.to) fs.unlinkSync(path.join(root, change.from));
    }
  }
  console.log(`${apply ? changes.length : 0} file(s) updated`);
}
