import { FileService } from './FileService';
import {
  ProjectPaths,
  ResearchAssistantConfig,
} from '../models/types';
import { LEGACY_RESEARCH_DEFAULTS, PROJECT_CONFIG_PATH, SHARED_RESEARCH_DEFAULTS, normalizeConfig, resolvePaths } from './ProjectPathsCore';

export { PROJECT_CONFIG_PATH } from './ProjectPathsCore';

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
      return normalizeConfig(JSON.parse(raw) as Partial<ResearchAssistantConfig>);
    }
    return this.discover();
  }

  async save(config: ResearchAssistantConfig): Promise<void> {
    const normalized = normalizeConfig(config);
    await this.fileService.writeFile(
      PROJECT_CONFIG_PATH,
      `${JSON.stringify(normalized, null, 2)}\n`
    );
  }

  resolvePaths(config: ResearchAssistantConfig): ProjectPaths {
    return resolvePaths(config);
  }

  private async discover(): Promise<ResearchAssistantConfig> {
    if (await this.fileService.exists('manuscript/main.tex') &&
        (await this.fileService.exists('assets') || await this.fileService.exists('project.md'))) {
      return normalizeConfig({
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

    return normalizeConfig({
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
}
