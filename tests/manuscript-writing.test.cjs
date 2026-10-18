const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const cli = path.resolve(__dirname, '../out/manuscript-writing.cjs');
const uri = (fsPath) => ({ fsPath });
const vscode = {
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
  FileType: { File: 1, Directory: 2 },
  workspace: {
    fs: {
      createDirectory: async (target) => fsp.mkdir(target.fsPath, { recursive: true }),
      readFile: async (target) => fsp.readFile(target.fsPath),
      writeFile: async (target, bytes) => fsp.writeFile(target.fsPath, bytes),
      stat: async (target) => {
        const value = await fsp.stat(target.fsPath);
        return { type: value.isDirectory() ? 2 : 1 };
      },
    },
  },
};

function bundled(file) {
  const built = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '..', file)],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(
    (name) => name === 'vscode' ? vscode : require(name), module, module.exports
  );
  return module.exports;
}

const { FileService } = bundled('src/services/FileService.ts');
const { ProjectConfigService } = bundled('src/services/ProjectConfigService.ts');

function fixture(legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manuscript-writing-'));
  const latexRoot = legacy ? 'manuscript' : '.';
  const researchRoot = legacy ? '.' : 'research';
  const config = {
    version: 1, layout: legacy ? 'legacy' : 'overleaf-shared',
    latex: { projectRoot: latexRoot, main: 'main.tex', bibliography: 'references.bib', macros: [], notations: null, sections: 'sections' },
    research: {
      root: researchRoot, project: path.join(researchRoot, 'project.md'),
      paperIndex: path.join(researchRoot, 'papers.md'), assets: path.join(researchRoot, 'assets'),
      definitions: path.join(researchRoot, 'definitions'), ideas: path.join(researchRoot, 'ideas'),
      plans: path.join(researchRoot, 'plans'), papers: path.join(researchRoot, 'papers'),
      localSourcePdfs: 'research-local/raw_papers',
    },
  };
  fs.writeFileSync(path.join(root, '.research-assistant.json'), JSON.stringify(config));
  const fileService = new FileService(uri(root));
  const paths = new ProjectConfigService(fileService).resolvePaths(config);
  const at = (relative) => path.join(root, relative);
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(at(relative)), { recursive: true });
    fs.writeFileSync(at(relative), content);
  };
  const read = (relative) => fs.readFileSync(at(relative), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' });
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, config, fileService, paths, at, write, read, run, cleanup };
}

function addSection(p, id = 'main_result', title = 'Main result', assets = ['main_theorem']) {
  const outline = p.paths.writingOutline;
  p.write(outline, `# Manuscript outline\n\n## Sections\n\n1. [${title}](sections/${id}.md)\n`);
  p.write(path.join(p.paths.writingSections, `${id}.md`), `---\ntitle: ${title}\nassets: [${assets.join(', ')}]\n---\n\n## Purpose\n\nState the result.\n\n## Subsections\n\n- Proof.\n\n## Gaps\n\n- None.\n`);
}

function addAsset(p, id = 'main_theorem', status = 'approved', extra = '') {
  p.write(path.join(p.paths.assets, `${id}.md`), `---\ntype: theorem\ntitle: Main theorem\nstatus: ${status}\ndepends_on: []\nuses_definitions: []\n${extra}---\n\nA statement.\n`);
}

test('new and adopted scaffolds preserve TeX and derive writing paths from layout', async () => {
  for (const legacy of [false, true]) {
    const p = fixture(legacy);
    try {
      const existing = '\\documentclass{amsart}\n\\begin{document}\nExisting prose.\n\\end{document}\n';
      if (legacy) p.write(p.paths.mainTex, existing);
      await p.fileService.ensureProjectStructure(p.config, p.paths, !legacy, []);
      assert.ok(fs.existsSync(p.at(p.paths.writingOutline)));
      assert.ok(fs.existsSync(p.at(p.paths.writingSections)));
      assert.equal(p.paths.writingOutline, legacy ? 'writing/outline.md' : 'research/writing/outline.md');
      if (legacy) assert.equal(p.read(p.paths.mainTex), existing);
      else assert.match(p.read(p.paths.mainTex), /% research-assistant:sections:start\n% research-assistant:sections:end/);
      p.write(p.paths.writingOutline, 'custom outline');
      await p.fileService.ensureProjectStructure(p.config, p.paths, false, []);
      assert.equal(p.read(p.paths.writingOutline), 'custom outline');
    } finally { p.cleanup(); }
  }
});

test('prepare validates sources and creates a section once; sync changes only the marked block', async () => {
  const p = fixture();
  try {
    await p.fileService.ensureProjectStructure(p.config, p.paths, true, []);
    addSection(p);
    addAsset(p, 'main_theorem', 'approved', 'source:\n  kind: paper\n  paper_id: source_paper\n');
    p.write(p.paths.bibliography, '@article{source_paper, title={Source}}\n');
    assert.equal(p.run('sync', '--apply').status, 1);
    const preview = p.run('prepare', 'main_result', '--preview');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Citation: source_paper/);
    assert.equal(fs.existsSync(p.at(path.join(p.paths.sections, 'main_result.tex'))), false);
    assert.equal(p.run('prepare', 'main_result', '--apply').status, 0);
    const texPath = path.join(p.paths.sections, 'main_result.tex');
    assert.match(p.read(texPath), /\\section{Main result}/);
    assert.match(p.read(texPath), /% research-assistant:block id=main-theorem sources=main_theorem policy=assisted\n% TODO: Present main_theorem[^\n]*\n% research-assistant:endblock/);
    p.write(texPath, '\\section{Main result}\n% [main_theorem]\nAuthor edit.\n');
    assert.equal(p.run('prepare', 'main_result', '--apply').status, 0);
    assert.match(p.read(texPath), /Author edit/);
    const mainBefore = p.read(p.paths.mainTex);
    assert.equal(p.run('sync', '--preview').status, 0);
    assert.equal(p.read(p.paths.mainTex), mainBefore);
    assert.equal(p.run('sync', '--apply').status, 0);
    assert.match(p.read(p.paths.mainTex), /\\input{sections\/main_result}/);
    assert.match(p.read(p.paths.mainTex), /\\end{document}/);
    assert.equal(p.run('sync', '--apply').status, 0);
    assert.match(p.run('sync', '--preview').stdout, /already match/);
  } finally { p.cleanup(); }
});

test('prepare refuses unknown and unapproved assets, dependencies, and missing BibTeX keys', async () => {
  const p = fixture();
  try {
    await p.fileService.ensureProjectStructure(p.config, p.paths, true, []);
    addSection(p);
    assert.match(p.run('prepare', 'main_result', '--apply').stderr, /Missing asset dependency/);
    addAsset(p, 'main_theorem', 'draft');
    assert.match(p.run('prepare', 'main_result', '--apply').stderr, /Cannot draft from asset/);
    addAsset(p, 'main_theorem', 'approved');
    p.write(path.join(p.paths.assets, 'main_theorem.md'), p.read(path.join(p.paths.assets, 'main_theorem.md')).replace('depends_on: []', 'depends_on: [supporting_lemma]'));
    addAsset(p, 'supporting_lemma', 'draft');
    assert.match(p.run('prepare', 'main_result', '--apply').stderr, /supporting_lemma/);
    addAsset(p, 'supporting_lemma', 'approved', 'source:\n  kind: paper\n  paper_id: missing_key\n');
    assert.match(p.run('prepare', 'main_result', '--apply').stderr, /Missing BibTeX key/);
    assert.equal(fs.existsSync(p.at(path.join(p.paths.sections, 'main_result.tex'))), false);
  } finally { p.cleanup(); }
});

test('adopted main needs markers; legacy inputs use its LaTeX root', async () => {
  const p = fixture(true);
  try {
    const main = '\\documentclass{amsart}\n\\begin{document}\nOld text.\n\\end{document}\n';
    p.write(p.paths.mainTex, main);
    await p.fileService.ensureProjectStructure(p.config, p.paths, false, []);
    addSection(p);
    addAsset(p);
    assert.equal(p.run('prepare', 'main_result', '--apply').status, 0);
    assert.match(p.run('sync', '--apply').stderr, /Add the section markers/);
    assert.equal(p.read(p.paths.mainTex), main);
    p.write(p.paths.mainTex, main.replace('Old text.', '% research-assistant:sections:start\nResearcher note.\n% research-assistant:sections:end\nOld text.'));
    assert.match(p.run('sync', '--apply').stderr, /contains text other than inputs/);
    p.write(p.paths.mainTex, main.replace('Old text.', '% research-assistant:sections:start\n% research-assistant:sections:end\nOld text.'));
    assert.equal(p.run('sync', '--apply').status, 0);
    assert.match(p.read(p.paths.mainTex), /\\input{sections\/main_result}\n% research-assistant:sections:end\nOld text/);
  } finally { p.cleanup(); }
});

test('outline order controls inputs and one unfinished brief does not block another section preparation', async () => {
  const p = fixture();
  try {
    await p.fileService.ensureProjectStructure(p.config, p.paths, true, []);
    addSection(p, 'first', 'First', ['first_asset']);
    p.write(p.paths.writingOutline, '# Manuscript outline\n\n## Sections\n\n1. [First](sections/first.md)\n2. [Second](sections/second.md)\n');
    addAsset(p, 'first_asset');
    p.write(path.join(p.paths.writingSections, 'second.md'), '---\ntitle: Second\nassets: [missing_asset]\n---\n\n## Purpose\n\nLater.\n');
    assert.equal(p.run('prepare', 'first', '--apply').status, 0);
    assert.match(p.run('sync', '--preview').stderr, /unknown asset: missing_asset/);
    addAsset(p, 'missing_asset');
    assert.equal(p.run('prepare', 'second', '--apply').status, 0);
    assert.equal(p.run('sync', '--apply').status, 0);
    assert.match(p.read(p.paths.mainTex), /\\input{sections\/first}\n\\input{sections\/second}/);
    p.write(p.paths.writingOutline, '# Manuscript outline\n\n## Sections\n\n1. [Second](sections/second.md)\n2. [First](sections/first.md)\n');
    assert.equal(p.run('sync', '--apply').status, 0);
    assert.match(p.read(p.paths.mainTex), /\\input{sections\/second}\n\\input{sections\/first}/);
    p.write(p.paths.writingOutline, '# Manuscript outline\n\n## Sections\n\n1. [First](sections/first.md)\n2. [First](sections/first.md)\n');
    assert.match(p.run('sync', '--apply').stderr, /Duplicate section ID/);
  } finally { p.cleanup(); }
});

test('required definitions must be approved and included in section context', async () => {
  const p = fixture();
  try {
    await p.fileService.ensureProjectStructure(p.config, p.paths, true, []);
    addSection(p);
    addAsset(p);
    const assetPath = path.join(p.paths.assets, 'main_theorem.md');
    p.write(assetPath, p.read(assetPath).replace('uses_definitions: []', 'uses_definitions: [key_definition]'));
    const definitionPath = path.join(p.paths.definitions, 'key_definition.md');
    p.write(definitionPath, '---\ntype: definition\ntitle: Key definition\nstatus: draft\n---\n\nDefinition.\n');
    assert.match(p.run('prepare', 'main_result', '--apply').stderr, /Cannot draft from definition key_definition/);
    p.write(definitionPath, p.read(definitionPath).replace('status: draft', 'status: approved'));
    const result = p.run('prepare', 'main_result', '--preview');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Context: research\/definitions\/key_definition.md/);
  } finally { p.cleanup(); }
});

const OVERLEAF_MAIN = [
  '\\documentclass{amsart}',
  '\\newtheorem{theorem}{Theorem}[section]',
  '\\begin{document}',
  '\\title{Rigidity}',
  '\\begin{abstract}',
  'We prove things.',
  '\\end{abstract}',
  '\\maketitle',
  '',
  '% ---------- Introduction ----------',
  '\\section{Introduction}\\label{sec:intro}',
  'We study $X$; see Section~\\ref{sec:results}.',
  '% \\section{Old draft}',
  '',
  '\\section[Results]{Main results on $L^p$ [spaces]}',
  '\\label{sec:results}',
  '\\begin{theorem}\\label{thm:main} Every $X$ is rigid. \\end{theorem}',
  '\\begin{verbatim}',
  '\\section{not a heading}',
  '\\end{verbatim}',
  '',
  '\\appendix',
  '',
  '\\section{Proof of the lemma}',
  'Details.',
  '',
  '\\bibliographystyle{amsplain}',
  '\\bibliography{references}',
  '\\end{document}',
  '',
].join('\n');

test('adopt splits inline sections into files without changing the TeX, then sync and a second adopt agree', async () => {
  const p = fixture();
  try {
    p.write(p.paths.mainTex, OVERLEAF_MAIN);
    await p.fileService.ensureProjectStructure(p.config, p.paths, false, []);
    const preview = p.run('adopt', '--preview');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /split lines 10-26 at 3 \\section heading/);
    assert.match(preview.stdout, /detaches Overleaf comments/);
    assert.equal(p.read(p.paths.mainTex), OVERLEAF_MAIN);
    assert.equal(fs.existsSync(p.at('sections/intro.tex')), false);

    const applied = p.run('adopt', '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    const ids = ['intro', 'results', 'proof_of_the_lemma'];
    const main = p.read(p.paths.mainTex);
    const moved = ids.map((id) => p.read(`sections/${id}.tex`)).join('');
    assert.equal(main.replace(/% research-assistant:sections:start\n(?:\\input\{[^}]+\}\n)*% research-assistant:sections:end\n/, moved), OVERLEAF_MAIN);
    assert.match(main, /\\maketitle\n\n% research-assistant:sections:start\n\\input\{sections\/intro\}\n\\input\{sections\/results\}\n\\input\{sections\/proof_of_the_lemma\}\n% research-assistant:sections:end\n\\bibliographystyle/);
    assert.match(p.read('sections/intro.tex'), /^% ---------- Introduction/);
    assert.match(p.read('sections/proof_of_the_lemma.tex'), /^\\appendix\n\n\\section/);
    assert.match(p.read('sections/results.tex'), /\\section\{not a heading\}/);

    const outline = p.read(p.paths.writingOutline);
    assert.match(outline, /## Sections\n\n1\. \[Introduction\]\(sections\/intro\.md\)\n2\. \[Main results on \$L\^p\$ \(spaces\)\]\(sections\/results\.md\)\n3\. \[Proof of the lemma\]/);
    assert.match(p.read(path.join(p.paths.writingSections, 'results.md')), /^---\ntitle: "Main results on \$L\^p\$ \(spaces\)"\nassets: \[\]\n---/);
    const sync = p.run('sync', '--preview');
    assert.equal(sync.status, 0, sync.stderr);
    assert.match(sync.stdout, /already match/);
    assert.match(p.run('adopt', '--preview').stderr, /already lists sections/);
  } finally { p.cleanup(); }
});

test('adopt avoids existing section IDs, keeps CRLF, and leaves sections after the bibliography in main', async () => {
  const p = fixture();
  try {
    const main = '\\documentclass{amsart}\r\n\\begin{document}\r\n\\section{Intro}\r\nA.\r\n\\bibliography{references}\r\n\\section{Late appendix}\r\nB.\r\n\\end{document}\r\n';
    p.write(p.paths.mainTex, main);
    p.write('sections/intro.tex', 'unrelated file\n');
    await p.fileService.ensureProjectStructure(p.config, p.paths, false, []);
    const applied = p.run('adopt', '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Not split: "Late appendix" at line 6/);
    assert.equal(p.read('sections/intro.tex'), 'unrelated file\n');
    assert.equal(p.read('sections/intro_2.tex'), '\\section{Intro}\r\nA.\r\n');
    assert.equal(p.read(p.paths.mainTex), '\\documentclass{amsart}\r\n\\begin{document}\r\n% research-assistant:sections:start\r\n\\input{sections/intro_2}\r\n% research-assistant:sections:end\r\n\\bibliography{references}\r\n\\section{Late appendix}\r\nB.\r\n\\end{document}\r\n');
  } finally { p.cleanup(); }
});

test('adopt marks existing section inputs and refuses what it cannot place', async () => {
  const p = fixture();
  try {
    const main = '\\documentclass{amsart}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\n\\input{./sections/proofs.tex}\n\\bibliography{references}\n\\end{document}\n';
    p.write(p.paths.mainTex, main.replace('\n\n\\input{./', '\n\\vspace{1em}\n\\input{./'));
    p.write('sections/intro.tex', '\\section{Introduction}\nText.\n');
    p.write('sections/proofs.tex', '\\section{Proofs}\nText.\n');
    await p.fileService.ensureProjectStructure(p.config, p.paths, false, []);
    assert.match(p.run('adopt', '--apply').stderr, /Line 5 sits between the section inputs/);
    p.write(p.paths.mainTex, main);
    const applied = p.run('adopt', '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(p.read(p.paths.mainTex), main.replace('\\input{sections/intro}', '% research-assistant:sections:start\n\\input{sections/intro}').replace('proofs.tex}\n', 'proofs.tex}\n% research-assistant:sections:end\n'));
    assert.equal(p.read('sections/intro.tex'), '\\section{Introduction}\nText.\n');
    assert.match(p.read(p.paths.writingOutline), /1\. \[Introduction\]\(sections\/intro\.md\)\n2\. \[Proofs\]\(sections\/proofs\.md\)/);
    assert.equal(p.run('sync', '--apply').status, 0);
    assert.match(p.read(p.paths.mainTex), /start\n\\input\{sections\/intro\}\n\\input\{sections\/proofs\}\n% research-assistant:sections:end/);

    p.write(p.paths.writingOutline, '# Manuscript outline\n\n## Sections\n\n');
    fs.rmSync(p.at(p.paths.writingSections), { recursive: true });
    p.write(p.paths.mainTex, '\\documentclass{amsart}\n\\begin{document}\nJust prose.\n\\end{document}\n');
    assert.match(p.run('adopt', '--preview').stderr, /no \\section heading and no \\input/);
  } finally { p.cleanup(); }
});

const hasLatexmk = spawnSync('latexmk', ['-v'], { encoding: 'utf8' }).status === 0;
test('generated section and synced main compile with local TeX', { skip: !hasLatexmk }, async () => {
  const p = fixture();
  try {
    await p.fileService.ensureProjectStructure(p.config, p.paths, true, []);
    addSection(p);
    addAsset(p);
    assert.equal(p.run('prepare', 'main_result', '--apply').status, 0);
    assert.equal(p.run('sync', '--apply').status, 0);
    const latexRoot = p.at(p.config.latex.projectRoot);
    fs.mkdirSync(path.join(latexRoot, '.latex-out'), { recursive: true });
    const compile = spawnSync('latexmk', ['-pdf', '-halt-on-error', '-interaction=nonstopmode', '-outdir=.latex-out', 'main.tex'], {
      cwd: latexRoot, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    assert.ok(fs.existsSync(path.join(latexRoot, '.latex-out', 'main.pdf')));
  } finally { p.cleanup(); }
});

test('an adopted manuscript compiles to the same labels and numbering', { skip: !hasLatexmk }, async () => {
  const p = fixture();
  try {
    p.write(p.paths.mainTex, OVERLEAF_MAIN);
    p.write(p.paths.bibliography, '');
    await p.fileService.ensureProjectStructure(p.config, p.paths, false, []);
    const compile = (dir) => {
      const result = spawnSync('latexmk', ['-pdf', '-halt-on-error', '-interaction=nonstopmode', '-outdir=.latex-out', 'main.tex'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return fs.readFileSync(path.join(dir, '.latex-out', 'main.aux'), 'utf8');
    };
    const before = compile(p.root);
    fs.rmSync(p.at('.latex-out'), { recursive: true, force: true });
    assert.equal(p.run('adopt', '--apply').status, 0);
    assert.equal(compile(p.root), before);
  } finally { p.cleanup(); }
});
