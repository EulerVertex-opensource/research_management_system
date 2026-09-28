import * as path from 'path';
import { ProjectPaths, ResearchAssistantConfig, SyncConfig } from '../models/types';

/**
 * Pure path resolution shared by the extension and the bundled CLI scripts.
 * It must not import `vscode`.
 */

export const PROJECT_CONFIG_PATH = '.research-assistant.json';

export const SHARED_RESEARCH_DEFAULTS: ResearchAssistantConfig['research'] = {
  root: 'research',
  project: 'research/project.md',
  paperIndex: 'research/papers.md',
  assets: 'research/assets',
  definitions: 'research/definitions',
  ideas: 'research/ideas',
  plans: 'research/plans',
  papers: 'research/papers',
  localSourcePdfs: 'research-local/raw_papers',
};

export const LEGACY_RESEARCH_DEFAULTS: ResearchAssistantConfig['research'] = {
  root: '.',
  project: 'project.md',
  paperIndex: 'papers.md',
  assets: 'assets',
  definitions: 'definitions',
  ideas: 'ideas',
  plans: 'plans',
  papers: 'papers',
  localSourcePdfs: 'raw_papers',
};

export function normalizeRelative(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Research Assistant paths must stay inside the workspace: ${value}`);
  }
  return normalized || '.';
}

function joinProjectPath(projectRoot: string, child: string): string {
  return projectRoot === '.' ? child : path.posix.join(projectRoot, child);
}

export function normalizeConfig(raw: Partial<ResearchAssistantConfig>): ResearchAssistantConfig {
  const layout = raw.layout === 'legacy' ? 'legacy' : 'overleaf-shared';
  const researchDefaults = layout === 'legacy' ? LEGACY_RESEARCH_DEFAULTS : SHARED_RESEARCH_DEFAULTS;
  const latexDefaults = layout === 'legacy'
    ? { projectRoot: 'manuscript', main: 'main.tex', bibliography: 'reference.bib', macros: ['macro.tex'], notations: 'notations.tex', sections: 'sections' }
    : { projectRoot: '.', main: 'main.tex', bibliography: 'references.bib', macros: [] as string[], notations: null, sections: 'sections' };
  const latex = raw.latex ?? latexDefaults;
  const research = raw.research ?? researchDefaults;
  const ideaPath = normalizeRelative(research.ideas, researchDefaults.ideas);

  return {
    version: 1,
    layout,
    sync: normalizeSyncConfig(raw.sync),
    latex: {
      projectRoot: normalizeRelative(latex.projectRoot, latexDefaults.projectRoot),
      main: normalizeRelative(latex.main, latexDefaults.main),
      bibliography: normalizeRelative(latex.bibliography, latexDefaults.bibliography),
      macros: Array.isArray(latex.macros)
        ? latex.macros.map((item) => normalizeRelative(item, 'macros.tex'))
        : latexDefaults.macros,
      notations: latex.notations === null || latex.notations === undefined
        ? null
        : normalizeRelative(latex.notations, 'notations.tex'),
      sections: normalizeRelative(latex.sections, latexDefaults.sections),
    },
    research: {
      root: normalizeRelative(research.root, researchDefaults.root),
      project: normalizeRelative(research.project, researchDefaults.project),
      paperIndex: normalizeRelative(research.paperIndex, researchDefaults.paperIndex),
      assets: normalizeRelative(research.assets, researchDefaults.assets),
      definitions: normalizeRelative(research.definitions, researchDefaults.definitions),
      ideas: ideaPath,
      plans: normalizeRelative(research.plans, path.posix.join(path.posix.dirname(ideaPath), 'plans')),
      papers: normalizeRelative(research.papers, researchDefaults.papers),
      localSourcePdfs: normalizeRelative(research.localSourcePdfs, researchDefaults.localSourcePdfs),
    },
  };
}

const optionalText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function normalizeSyncConfig(raw: Partial<SyncConfig> | undefined): SyncConfig {
  const sync = raw ?? {};
  return {
    remote: optionalText(sync.remote) ?? 'origin',
    branch: optionalText(sync.branch),
    overleafRemote: optionalText(sync.overleafRemote),
    overleafBranch: optionalText(sync.overleafBranch) ?? 'master',
    strategy: sync.strategy === 'merge' ? 'merge' : 'rebase',
    include: Array.isArray(sync.include) ? sync.include.map((item) => normalizeRelative(item, '.')).filter((item) => item !== '.') : [],
    latexCommand: optionalText(sync.latexCommand),
    signCommits: sync.signCommits === true,
    identity: optionalText(sync.identity),
  };
}

export function resolvePaths(config: ResearchAssistantConfig): ProjectPaths {
  const latexRoot = normalizeRelative(config.latex.projectRoot, '.');
  return {
    config: PROJECT_CONFIG_PATH,
    mainTex: joinProjectPath(latexRoot, normalizeRelative(config.latex.main, 'main.tex')),
    bibliography: joinProjectPath(latexRoot, normalizeRelative(config.latex.bibliography, 'references.bib')),
    macroFiles: config.latex.macros.map((item) =>
      joinProjectPath(latexRoot, normalizeRelative(item, 'macros.tex'))
    ),
    notations: config.latex.notations
      ? joinProjectPath(latexRoot, normalizeRelative(config.latex.notations, 'notations.tex'))
      : null,
    sections: joinProjectPath(latexRoot, normalizeRelative(config.latex.sections, 'sections')),
    researchRoot: normalizeRelative(config.research.root, 'research'),
    projectMd: normalizeRelative(config.research.project, 'research/project.md'),
    paperIndex: normalizeRelative(config.research.paperIndex, 'research/papers.md'),
    assets: normalizeRelative(config.research.assets, 'research/assets'),
    definitions: normalizeRelative(config.research.definitions, 'research/definitions'),
    ideas: normalizeRelative(config.research.ideas, 'research/ideas'),
    plans: normalizeRelative(config.research.plans, path.posix.join(path.posix.dirname(config.research.ideas), 'plans')),
    writingRoot: path.posix.join(normalizeRelative(config.research.root, 'research'), 'writing'),
    writingOutline: path.posix.join(normalizeRelative(config.research.root, 'research'), 'writing', 'outline.md'),
    writingSections: path.posix.join(normalizeRelative(config.research.root, 'research'), 'writing', 'sections'),
    papers: normalizeRelative(config.research.papers, 'research/papers'),
    localSourcePdfs: normalizeRelative(config.research.localSourcePdfs, 'research-local/raw_papers'),
  };
}

/** Resolve project paths from the raw contents of `.research-assistant.json`. */
export function pathsFromConfigText(raw: string): ProjectPaths {
  return resolvePaths(normalizeConfig(JSON.parse(raw) as Partial<ResearchAssistantConfig>));
}
