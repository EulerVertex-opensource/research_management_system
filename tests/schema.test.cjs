const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const matter = require('gray-matter');

function load(file, stubs = {}) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'], external: Object.keys(stubs) });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, (name) => stubs[name] ?? require(name));
  return module.exports;
}

const { sectionContent, hasSection, hasSectionContent, sectionHeadings, statementPart, stripManagedBlocks } = load('../src/domain/sections.ts');
const { nodeProblems, duplicateIds, stripForeignFields } = load('../src/domain/schema.ts');
const { reverseRelations } = load('../src/domain/relations.ts');
const { toIdeaKind, statusesFor } = load('../src/domain/nodeKinds.ts');
const { upgradeProjectText } = load('../src/services/SchemaMigration.ts');
const { requiredResults, isLegacyProject, summarizeProject } = load('../src/domain/project.ts');
const { researchDigest } = load('../src/services/ResearchLoopModel.ts');

test('one section parser serves every caller', () => {
  const body = 'Statement text.\n\n## Proof\n\nStep one.\n\n## Difference from failed plans\n\n- plan_a: new route\n\n## Empty\n\n## Outcome\n\nDone.';
  assert.equal(sectionContent(body, 'Proof'), 'Step one.');
  assert.equal(sectionContent(body, 'Difference from failed plans'), '- plan_a: new route');
  assert.equal(sectionContent(body, 'Outcome'), 'Done.');
  assert.equal(sectionContent(body, 'Missing'), '');
  assert.equal(hasSection(body, 'Empty'), true);
  assert.equal(hasSectionContent(body, 'Empty'), false);
  assert.deepEqual(sectionHeadings(body), ['Proof', 'Difference from failed plans', 'Empty', 'Outcome']);
  assert.equal(statementPart(body), 'Statement text.\n\n');
  // Regex metacharacters in a heading (a paper slug, a parenthesis) are literal.
  assert.equal(sectionContent('## a.b (c)\n\nx\n', 'a.b (c)'), 'x');
  assert.equal(sectionContent('## aXb\n\nx\n', 'a.b'), '');
  assert.equal(stripManagedBlocks('a<!-- research-assistant:proof-ideas:start -->\nlinks\n<!-- research-assistant:proof-ideas:end -->b'), 'ab');
});

test('node schema rules are shared by the loop, the dashboard, and the CLI', () => {
  const asset = { type: 'theorem', title: 'T', status: 'draft' };
  assert.deepEqual(nodeProblems('asset', 't', { ...asset, source: { kind: 'textbook' } }, 'Body.'), []);
  assert.match(nodeProblems('asset', 't', { ...asset, source: { kind: 'rumour' } }, 'Body.')[0], /source\.kind must be one of/);
  assert.match(nodeProblems('asset', 't', { ...asset, status: 'approved' }, 'Body.')[0], /approval is a researcher action/);
  assert.deepEqual(nodeProblems('asset', 't', { ...asset, status: 'approved' }, 'Body.', { allowApproved: true }), []);
  assert.match(nodeProblems('asset', 't', { ...asset, source: { kind: 'paper', paper_id: 'x', location: 'p. 1' } }, 'Body.', { paperIds: new Set() })[0], /indexed paper/);
  assert.match(nodeProblems('asset', 't', { ...asset, depends_on: 'lemma' }, 'Body.')[0], /depends_on must be a list/);
  assert.match(nodeProblems('idea', 'i', { type: 'idea', title: 'I', status: 'draft', idea_kind: 'hunch' }, 'Text.')[0], /idea_kind must be one of/);
  assert.deepEqual(nodeProblems('idea', 'i', { type: 'idea', title: 'I', status: 'draft', idea_kind: 'question' }, 'Text.'), []);
  const plan = { type: 'plan', title: 'P', target_asset: 't' };
  const steps = '## Goal\n\nG.\n\n## Plan\n\n1. [ ] Step.\n\n## Verification\n\nV.\n';
  assert.deepEqual(nodeProblems('plan', 'p', { ...plan, status: 'pending' }, steps), []);
  assert.match(nodeProblems('plan', 'p', { ...plan, status: 'failed' }, steps)[0], /obstruction under ## Failure/);
  assert.match(nodeProblems('plan', 'p', { ...plan, status: 'succeeded' }, steps)[0], /## Outcome/);
  assert.deepEqual(nodeProblems('plan', 'p', { ...plan, status: 'succeeded' }, `${steps}\n## Outcome\n\nIn t.\n`), []);
  assert.deepEqual(nodeProblems('plan', 'p', { ...plan, status: 'abandoned' }, 'Dropped.'), []);
  assert.match(nodeProblems('plan', 'p', { type: 'proof_record', title: 'P', target_asset: 't' }, 'x')[0], /legacy type; run `research-maintenance migrate`/);
  assert.deepEqual([...statusesFor('plan')], ['pending', 'failed', 'succeeded', 'abandoned']);
  assert.equal(toIdeaKind(undefined, ['open-question']), 'question');
  assert.equal(toIdeaKind('risk'), 'risk');
  assert.equal(toIdeaKind('nonsense'), 'approach');
});

test('IDs are global across folders, foreign relations are dropped, and reverse relations are derived', () => {
  assert.deepEqual(duplicateIds(['research/assets/a.md', 'research/ideas/b.md', 'research/plans/a.md']), ['research/plans/a.md: node ID a is already used by research/assets/a.md; IDs are global across research folders.']);
  assert.deepEqual(stripForeignFields('idea', { type: 'idea', related_assets: ['a'], depends_on: ['x'], used_in: ['y'], origin: 'agent' }), { type: 'idea', related_assets: ['a'], origin: 'agent' });
  assert.deepEqual(stripForeignFields('asset', { type: 'theorem', refutes: 'a', depends_on: [] }, 'theorem'), { type: 'theorem', depends_on: [] });
  const index = reverseRelations([
    { id: 'main', type: 'theorem', depends_on: ['lemma'], uses_definitions: ['group'] },
    { id: 'lemma', type: 'lemma', uses_definitions: ['group'] },
    { id: 'attempt', type: 'plan', target_asset: 'main', inspired_by: ['hunch'] },
    { id: 'hunch', type: 'idea', related_assets: ['main'] },
    { id: 'counter', type: 'example', refutes: 'lemma' },
  ]);
  assert.deepEqual(index.get('lemma').usedIn, ['main']);
  assert.deepEqual(index.get('group').usedBy, ['lemma', 'main']);
  assert.deepEqual(index.get('main').plans, ['attempt']);
  assert.deepEqual(index.get('main').ideas, ['hunch']);
  assert.deepEqual(index.get('hunch').inspired, ['attempt']);
  assert.deepEqual(index.get('lemma').refutedBy, ['counter']);
});

const legacyProject = '# Project\n\n## Main Problem\n\nProve A.\n\n## Background\n\nClassical.\n\n## Current Goals\n\nFind a proof.\n\n## Required Results\n\nList one stable asset ID per bullet, for example main_theorem. The research loop uses this list to decide manuscript readiness.\n\n- main_theorem: the central claim\n- `helper_lemma`\n\nThe lemma may be dropped later.\n\n## Known Results\n\nLemma 2 of Smith.\n\n## Open Questions\n\nIs compactness needed?\n\n## Writing Status\n\nIntroduction drafted.\n\n## Seminar notes\n\nTalk on Friday.\n';

test('project.md upgrade keeps every paragraph and moves required results into frontmatter', () => {
  const { text, review } = upgradeProjectText(legacyProject);
  assert.equal(isLegacyProject(text), false);
  assert.deepEqual(requiredResults(text), [{ id: 'main_theorem', role: 'the central claim' }, { id: 'helper_lemma' }]);
  const body = matter(text).content;
  for (const phrase of ['Prove A.', 'Classical.', 'Find a proof.', 'The lemma may be dropped later.', 'Lemma 2 of Smith.', 'Is compactness needed?', 'Introduction drafted.', 'Talk on Friday.']) assert.ok(body.includes(phrase), phrase);
  assert.doesNotMatch(body, /List one stable asset ID/);
  assert.match(body, /## Intended Contribution\n\nFind a proof\./);
  assert.match(body, /## Seminar notes\n\nTalk on Friday\./);
  assert.ok(review.some((item) => /Current Goals became ## Intended Contribution/.test(item)));
  const summary = summarizeProject(text, [
    { id: 'main_theorem', type: 'theorem', title: 'Main', status: 'approved', tags: [], filePath: 'research/assets/main_theorem.md' },
    { id: 'idea_q', type: 'idea', title: 'Compactness?', status: 'draft', idea_kind: 'question', tags: [], filePath: 'research/ideas/idea_q.md' },
  ], ['Introduction']);
  assert.deepEqual(summary.required, [{ id: 'main_theorem', role: 'the central claim', title: 'Main', status: 'approved' }, { id: 'helper_lemma', title: undefined, status: undefined }]);
  assert.deepEqual(summary.openQuestions, [{ id: 'idea_q', title: 'Compactness?' }]);
  assert.equal(summary.legacy, false);
});

function v1Project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-migration-'));
  const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  write('.research-assistant.json', JSON.stringify({ version: 1, layout: 'overleaf-shared' }));
  write('research/project.md', legacyProject);
  const theorem = '---\ntype: theorem\ntitle: "002. Main theorem"\nstatus: approved\nsource:\n  kind: self_proved\ndepends_on: [helper_lemma]\nuses_definitions: []\nused_in: []\ntags: []\n---\n\n## Statement\n\nA holds.\n\n## Proof\n\nBy the lemma.\n\n<!-- research-assistant:proof-ideas:start -->\n## Proof plans\n\nEarlier plans list.\n<!-- research-assistant:proof-ideas:end -->\n';
  const lemma = '---\ntype: lemma\ntitle: "001. Helper lemma"\nstatus: draft\ndepends_on: []\nused_in:\n  - main_theorem\ntags: []\n---\n\n## Statement\n\nB holds.\n';
  write('research/assets/main_theorem.md', theorem);
  write('research/assets/helper_lemma.md', lemma);
  write('research/definitions/group.md', '---\ntype: definition\ntitle: "001. Definition (group)"\nstatus: draft\ndepends_on: []\n---\n\nA group is a set with an operation.\n');
  write('research/plans/attempt.md', '---\ntype: proof_record\ntitle: Attempt\ntarget_asset: main_theorem\ninspired_by: []\n---\n\n## Goal\n\nTarget: [asset](../assets/main_theorem.md)\n\n## Plan\n\n1. [x] Use the lemma.\n\n## Verification\n\nDone.\n\n## Outcome\n\nProof in main_theorem.\n');
  write('research/ideas/open.md', '---\ntype: idea\ntitle: Compactness?\nstatus: draft\ntags: [open-question]\nrelated_assets: []\n---\n\nIs compactness needed?\n');
  write('research/approvals/project.json', JSON.stringify({ kind: 'project', target: 'project', digest: researchDigest(legacyProject, 'project'), approvedAt: 'then' }, null, 2) + '\n');
  write('research/approvals/assets/main_theorem.json', JSON.stringify({ kind: 'asset', target: 'main_theorem', digest: researchDigest(theorem, 'asset'), approvedAt: 'then' }, null, 2) + '\n');
  const run = (cli, ...args) => spawnSync(process.execPath, [path.resolve(__dirname, `../out/${cli}.cjs`), ...args, '--project', root], { encoding: 'utf8' });
  return { root, write, read, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('migrate upgrades a schema-1 project in one pass and keeps valid approvals', () => {
  const p = v1Project();
  try {
    const before = p.read('research/assets/main_theorem.md');
    const preview = p.run('research-maintenance', 'migrate');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Migrating: project\.md predates required_results frontmatter; numbered titles; stored used_in lists; proof_record files; managed link blocks in node files; source\.kind self_proved\./);
    assert.match(preview.stdout, /UPDATE research\/approvals\/project\.json/);
    assert.equal(p.read('research/assets/main_theorem.md'), before);

    const applied = p.run('research-maintenance', 'migrate', '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Carried the project approval over/);
    const theorem = matter(p.read('research/assets/main_theorem.md'));
    assert.equal(theorem.data.title, 'Main theorem');
    assert.equal(theorem.data.used_in, undefined);
    assert.equal(theorem.data.status, 'approved');
    assert.doesNotMatch(p.read('research/assets/main_theorem.md'), /research-assistant:|Earlier plans list/);
    assert.match(p.read('research/assets/main_theorem.md'), /By the lemma\.\n$/);
    assert.equal(theorem.data.source.kind, 'original');
    assert.equal(matter(p.read('research/assets/helper_lemma.md')).data.used_in, undefined);
    assert.equal(matter(p.read('research/definitions/group.md')).data.title, 'Definition (group)');
    assert.deepEqual([matter(p.read('research/plans/attempt.md')).data.type, matter(p.read('research/plans/attempt.md')).data.status], ['plan', 'succeeded']);
    assert.equal(matter(p.read('research/ideas/open.md')).data.idea_kind, 'question');
    assert.deepEqual(matter(p.read('research/project.md')).data.required_results.map((item) => item.id), ['main_theorem', 'helper_lemma']);

    // Approvals survive: the project record was re-stamped, the asset digest ignores titles and used_in.
    const project = p.read('research/project.md');
    assert.equal(JSON.parse(p.read('research/approvals/project.json')).digest, researchDigest(project, 'project'));
    assert.equal(JSON.parse(p.read('research/approvals/assets/main_theorem.json')).digest, researchDigest(p.read('research/assets/main_theorem.md'), 'asset'));
    const validation = p.run('research-maintenance', 'validate');
    assert.equal(validation.status, 0, validation.stdout);
    assert.match(validation.stdout, /001 helper_lemma — Helper lemma\n\s+002 main_theorem — Main theorem/);
    const loop = p.run('research-loop', 'validate');
    assert.equal(loop.status, 0, loop.stdout + loop.stderr);
    assert.doesNotMatch(loop.stdout, /without a matching/);

    const snapshot = ['research/project.md', 'research/assets/main_theorem.md', 'research/plans/attempt.md'].map(p.read);
    assert.match(p.run('research-maintenance', 'migrate', '--apply').stdout, /already uses the current schema/);
    assert.deepEqual(['research/project.md', 'research/assets/main_theorem.md', 'research/plans/attempt.md'].map(p.read), snapshot);
  } finally { p.cleanup(); }
});

test('a stale project approval is reported, never re-approved, by migration', () => {
  const p = v1Project();
  try {
    p.write('research/approvals/project.json', JSON.stringify({ kind: 'project', target: 'project', digest: 'stale', approvedAt: 'then' }) + '\n');
    const applied = p.run('research-maintenance', 'migrate', '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /approval was already stale before migration/);
    assert.equal(JSON.parse(p.read('research/approvals/project.json')).digest, 'stale');
  } finally { p.cleanup(); }
});

test('migrate --apply refuses uncommitted research changes in a git repository', () => {
  const p = v1Project();
  try {
    const git = (...args) => spawnSync('git', args, { cwd: p.root, encoding: 'utf8' });
    if (git('init', '-q').status !== 0) return;
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'v1');
    p.write('research/ideas/new.md', '---\ntype: idea\ntitle: New\nstatus: draft\n---\n\nUncommitted.\n');
    const refused = p.run('research-maintenance', 'migrate', '--apply');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Commit or stash research changes first/);
    assert.equal(matter(p.read('research/plans/attempt.md')).data.type, 'proof_record');
    assert.equal(p.run('research-maintenance', 'migrate', '--apply', '--force').status, 0);
  } finally { p.cleanup(); }
});

test('bundled skills: fourteen skills, each referenced script is built and installed with its skill', () => {
  const skillsRoot = path.resolve(__dirname, '../skills');
  const skills = fs.readdirSync(skillsRoot).filter((name) => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md'))).sort();
  assert.deepEqual(skills, ['check-notation', 'draft-latex', 'execute-proof', 'explore-research', 'extract-research-nodes', 'import-math-paper', 'plan-manuscript', 'plan-proof', 'research-loop', 'research-maintenance', 'revise-manuscript-prose', 'search-object', 'teach', 'verify-proof']);
  const vscode = { Uri: {}, workspace: {}, FileType: {} };
  const { SKILL_SCRIPTS, isBundledSkillManifest } = load('../src/services/SkillInstallerService.ts', { vscode });
  const { RETIRED_SKILLS } = load('../src/services/AgentProviders.ts');
  for (const skill of skills) {
    const manifest = fs.readFileSync(path.join(skillsRoot, skill, 'SKILL.md'), 'utf8');
    assert.ok(isBundledSkillManifest(manifest, skill), skill);
    for (const match of manifest.matchAll(/skills\/([a-z-]+)\/scripts\/([a-z-]+\.cjs)/g)) {
      assert.ok((SKILL_SCRIPTS[match[1]] ?? []).includes(match[2]), `${skill} references ${match[1]}/${match[2]}`);
      assert.ok(fs.existsSync(path.resolve(__dirname, '../out', match[2])), `${match[2]} is built`);
    }
    for (const retired of RETIRED_SKILLS) assert.doesNotMatch(manifest, new RegExp(`\`${retired}\``), `${skill} mentions retired ${retired}`);
  }
  assert.equal(isBundledSkillManifest('---\nname: summarize\ndescription: Summarize my meeting notes.\n---\n', 'summarize'), false);
  assert.equal(isBundledSkillManifest('---\nname: summarize\ndescription: Summarize selected mathematical research nodes.\n---\n', 'summarize'), true);
});

test('the generated .gitignore covers every preinstalled skill and generated agent file, and nothing of the researcher\'s', () => {
  const { generatedAgentIgnores } = load('../src/services/AgentIntegrationCore.ts');
  const skills = fs.readdirSync(path.resolve(__dirname, '../skills')).filter((name) => fs.existsSync(path.resolve(__dirname, '../skills', name, 'SKILL.md')));
  const ignores = generatedAgentIgnores(skills);
  for (const dir of ['.claude/skills', '.agents/skills']) {
    for (const skill of [...skills, 'summarize', 'order-assets', 'prove-asset']) assert.ok(ignores.includes(`/${dir}/${skill}/`), `${dir}/${skill}`);
  }
  for (const file of ['/.claude/agents/research-worker-light.md', '/.claude/agents/research-worker-deep.md', '/.claude/settings.local.json', '/.mcp.json', '/.codex/hooks.json', '/.codex/agents/research-worker-light.toml', '/.codex/agents/research-worker-deep.toml']) assert.ok(ignores.includes(file), file);
  assert.ok(!ignores.some((entry) => entry === '/.claude/agents/' || entry === '/.claude/skills/' || entry === '/.agents/skills/'));
  assert.equal(new Set(ignores).size, ignores.length);
});
