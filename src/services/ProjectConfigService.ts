import * as path from 'path';
import { FileService } from './FileService';
import {
  ProjectPaths,
  ResearchAssistantConfig,
} from '../models/types';

export const PROJECT_CONFIG_PATH = '.research-assistant.json';

const SHARED_RESEARCH_DEFAULTS: ResearchAssistantConfig['research'] = {
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

const LEGACY_RESEARCH_DEFAULTS: ResearchAssistantConfig['research'] = {
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

function normalizeRelative(value: unknown, fallback: string): string {
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

function parseInputTargets(mainContent: string): string[] {
  const targets: string[] = [];
  const pattern = /\\(?:input|include)\s*\{([^}]+)\}/g;
  for (let match = pattern.exec(mainContent); match; match = pattern.exec(mainContent)) {
    targets.push(match[1].trim());
  }
  return targets;
}

function parseBibliographyTargets(mainContent: string): string[] {
  const targets: string[] = [];
  const addBibPattern = /\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  for (let match = addBibPattern.exec(mainContent); match; match = addBibPattern.exec(mainContent)) {
    targets.push(match[1].trim());
  }
  const bibPattern = /\\bibliography\s*\{([^}]+)\}/g;
  for (let match = bibPattern.exec(mainContent); match; match = bibPattern.exec(mainContent)) {
    targets.push(...match[1].split(',').map((item) => item.trim()));
  }
  return targets.filter(Boolean).map((target) => target.endsWith('.bib') ? target : `${target}.bib`);
}

export class ProjectConfigService {
  constructor(private readonly fileService: FileService) {}

  async hasSavedConfig(): Promise<boolean> {
    return this.fileService.exists(PROJECT_CONFIG_PATH);
  }

  async loadOrDiscover(): Promise<ResearchAssistantConfig> {
    if (await this.hasSavedConfig()) {
      const raw = await this.fileService.readFile(PROJECT_CONFIG_PATH);
      return this.normalizeConfig(JSON.parse(raw) as Partial<ResearchAssistantConfig>);
    }
    return this.discover();
  }

  async save(config: ResearchAssistantConfig): Promise<void> {
    const normalized = this.normalizeConfig(config);
    await this.fileService.writeFile(
      PROJECT_CONFIG_PATH,
      `${JSON.stringify(normalized, null, 2)}\n`
    );
  }

  resolvePaths(config: ResearchAssistantConfig): ProjectPaths {
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
      papers: normalizeRelative(config.research.papers, 'research/papers'),
      localSourcePdfs: normalizeRelative(config.research.localSourcePdfs, 'research-local/raw_papers'),
    };
  }

  private async discover(): Promise<ResearchAssistantConfig> {
    if (await this.fileService.exists('manuscript/main.tex') &&
        (await this.fileService.exists('assets') || await this.fileService.exists('project.md'))) {
      return this.normalizeConfig({
        version: 1,
        layout: 'legacy',
        latex: {
          projectRoot: 'manuscript',
          main: 'main.tex',
          bibliography: 'reference.bib',
          macros: ['macro.tex'],
          notations: 'notations.tex',
          sections: 'sections',
        },
        research: LEGACY_RESEARCH_DEFAULTS,
      });
    }

    const texFiles = await this.fileService.listFiles('.', '.tex');
    const compilable: string[] = [];
    for (const texFile of texFiles.sort()) {
      const content = await this.fileService.readFile(texFile).catch(() => '');
      if (/\\documentclass(?:\[[^\]]*\])?\s*\{/.test(content)) compilable.push(texFile);
    }
    const main = compilable.includes('main.tex') ? 'main.tex' : compilable[0] ?? 'main.tex';
    const mainContent = await this.fileService.readFile(main).catch(() => '');

    const rootBibFiles = (await this.fileService.listFiles('.', '.bib')).sort();
    let referencedBib: string | undefined;
    for (const candidate of parseBibliographyTargets(mainContent)) {
      if (await this.fileService.exists(candidate)) {
        referencedBib = candidate;
        break;
      }
    }
    const preferredBib = ['references.bib', 'reference.bib', 'bibliography.bib', 'refs.bib']
      .find((candidate) => rootBibFiles.includes(candidate));
    const bibliography = referencedBib ?? preferredBib ?? rootBibFiles[0] ?? 'references.bib';

    const inputTargets = parseInputTargets(mainContent).map((target) =>
      target.endsWith('.tex') ? target : `${target}.tex`
    );
    const isNewManuscript = compilable.length === 0;
    const macros = inputTargets.filter((target) => /(^|\/)(macro|macros|preamble)\.tex$/i.test(target));
    for (const candidate of ['macros.tex', 'macro.tex', 'preamble.tex']) {
      if (!macros.includes(candidate) && await this.fileService.exists(candidate)) macros.push(candidate);
    }
    const notationInput = inputTargets.find((target) => /(^|\/)notations?\.tex$/i.test(target));
    if (isNewManuscript && macros.length === 0) macros.push('macros.tex');
    const notations = notationInput ??
      (await this.fileService.exists('notations.tex') ? 'notations.tex' : isNewManuscript ? 'notations.tex' : null);

    return this.normalizeConfig({
      version: 1,
      layout: 'overleaf-shared',
      latex: {
        projectRoot: '.',
        main,
        bibliography,
        macros,
        notations,
        sections: 'sections',
      },
      research: SHARED_RESEARCH_DEFAULTS,
    });
  }

  private normalizeConfig(raw: Partial<ResearchAssistantConfig>): ResearchAssistantConfig {
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
}
