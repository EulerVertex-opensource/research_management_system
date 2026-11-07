const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');

function load(file) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', mainFields: ['module', 'main'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { projectShellWrite, shellScriptOf } = load('../src/services/ShellWrites.ts');
const root = '/work/project';
const scripts = {
  '/tmp/check.py': 'from sympy import *\nprint(factor(x**2 - 1))\n',
  '/tmp/edit.py': "open('research/assets/key_lemma.md', 'w').write('x')\n",
  '/tmp/edit.sh': 'sed -i "s/a/b/" research/assets/key_lemma.md\n',
  '/work/project/tools/fix.js': "require('fs').writeFileSync('research/assets/a.md', '')\n",
};
const write = (command, cwd) => projectShellWrite(command, { root, cwd, readFile: (file) => scripts[file] });

test('shell commands that only read, or write outside the project, pass', () => {
  for (const command of [
    'cat research/assets/key_lemma.md',
    'grep -rn "lemma" research | head -20',
    'ls -la research/assets && wc -l research/assets/*.md',
    'echo hi > /dev/null 2>&1',
    'node .agents/skills/research-loop/scripts/research-loop.cjs teach pack key_lemma 2>/dev/null',
    "cat > /tmp/draft.md <<'EOF'\n## Proof\nWe have $a > b$; > research/x.md\nEOF",
    'cat > "$TMPDIR/draft.md" <<EOF\nbody\nEOF',
    'd=$(mktemp -d) && cat > "$(mktemp)" < research/assets/a.md',
    'cd /tmp && echo x > notes.md && mkdir sub',
    'cp research/assets/key_lemma.md /tmp/copy.md',
    'echo "a > b; rm -rf research"',
    'sed -n 1,20p research/assets/key_lemma.md',
    'python3 -c "from sympy import *; print(factor(x**2-1))"',
    'python3 /tmp/check.py',
    "python3 - <<'EOF'\nimport sys\nsys.stdout.write(str(2**10))\nEOF",
    'node -e "console.log(`${1+1}`)"',
    "python3 -c \"open('/tmp/out.txt','w').write('x')\"",
    'git status && git log --oneline -5 && git diff HEAD~1 -- research',
    'git stash list; git branch; git config user.name',
    'find research -name "*.md" -exec grep -l lemma {} \\;',
    'cd /tmp/scratch && git init',
    'curl -s https://example.org | head',
    'tar -tzf /tmp/a.tgz',
    'awk \'{print $1}\' research/papers.md',
    'cat <<< "x > research/y.md"',
    'pdftotext /tmp/a.pdf -',
  ]) assert.equal(write(command), undefined, command);
});

test('shell commands that write into the project are found, however they write', () => {
  for (const [command, target] of [
    ['echo x > research/assets/key_lemma.md', 'research/assets/key_lemma.md'],
    ['echo x >> notes.md', 'notes.md'],
    ['cat foo 2> err.log', 'err.log'],
    ['ls &> listing.txt', 'listing.txt'],
    ['echo x | tee -a research/ideas/a.md', 'research/ideas/a.md'],
    ['sed -i "s/a/b/" research/assets/key_lemma.md', 'research/assets/key_lemma.md'],
    ["sed -i '' 's/a/b/' research/assets/key_lemma.md", 'research/assets/key_lemma.md'],
    ['sed -i.bak -e s/a/b/ main.tex', 'main.tex'],
    ['perl -pi -e "s/a/b/" sections/intro.tex', 'sections/intro.tex'],
    ['rm -rf research/plans', 'research/plans'],
    ['mv research/assets/a.md /tmp/a.md', 'research/assets/a.md'],
    ['cp /tmp/draft.md research/assets/key_lemma.md', 'research/assets/key_lemma.md'],
    ['cp -r /tmp/x -t research/library', 'research/library'],
    ['touch research/new.md', 'research/new.md'],
    ['mkdir -p research/extra', 'research/extra'],
    ['chmod +x research/run.sh', 'research/run.sh'],
    ['truncate -s 0 references.bib', 'references.bib'],
    ['dd if=/dev/zero of=main.tex count=1', 'main.tex'],
    ['cd research && echo x > a.md', 'a.md'],
    [`echo x > ${root}/research/a.md`, `${root}/research/a.md`],
    ['echo x > "$OUT"', '$OUT'],
    ['git checkout -- research/assets/a.md', '.'],
    ['git -C /work/project commit -am wip', '/work/project'],
    ['git stash', '.'],
    ['git add -A', '.'],
    ['find research -name "*.bak" -delete', 'research'],
    ['find . -name "*.md" -exec sed -i s/a/b/ {} +', './f'],
    ['ls research/*.md | xargs rm', '$XARGS'],
    ['bash -c "echo x > research/a.md"', 'research/a.md'],
    ['sh -lc \'rm research/a.md\'', 'research/a.md'],
    ['eval "rm research/a.md"', 'research/a.md'],
    ['echo $(rm research/a.md)', 'research/a.md'],
    ['echo `touch research/a.md`', 'research/a.md'],
    ['bash /tmp/edit.sh', 'research/assets/key_lemma.md'],
    ["python3 -c \"open('research/x.md','w').write('x')\"", 'research/x.md'],
    ["python3 - <<'EOF'\nfrom pathlib import Path\nPath('research/x.md').write_text('y')\nEOF", 'research/x.md'],
    ['python3 /tmp/edit.py', 'research/assets/key_lemma.md'],
    ['node tools/fix.js', 'research/assets/a.md'],
    ["node -e \"require('fs').unlinkSync(process.argv[1])\" research/a.md", 'a node script'],
    ["awk '{print > \"research/out.md\"}' research/papers.md", 'research/out.md'],
    ['curl -o research/library/a.pdf https://example.org/a.pdf', 'research/library/a.pdf'],
    ['wget https://example.org/a.pdf', '.'],
    ['tar -xzf /tmp/a.tgz', '.'],
    ['unzip /tmp/a.zip -d research/library', 'research/library'],
    ['npm install', '.'],
    ["apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: research/assets/a.md\n@@\n-x\n+y\n*** End Patch\nEOF", 'research/assets/a.md'],
    ['FOO=1 sudo rm research/a.md', 'research/a.md'],
    ['true; rm research/a.md', 'research/a.md'],
    ['true\nrm research/a.md', 'research/a.md'],
  ]) {
    const found = write(command);
    assert.ok(found && found.startsWith(target), `${command} -> ${found}`);
  }
});

test('the directory the command starts in decides where relative paths land', () => {
  assert.equal(write('echo x > notes.md', '/tmp'), undefined);
  assert.ok(write('echo x > notes.md', `${root}/research`));
  assert.ok(write('cd ~ && cd /work/project && rm a.md', '/tmp'));
  assert.equal(write(`echo x > ${path.join(os.homedir(), 'elsewhere.md')}`), undefined);
});

test('a shell tool given as argv yields the script it runs', () => {
  assert.equal(shellScriptOf(['bash', '-lc', 'echo x > research/a.md']), 'echo x > research/a.md');
  assert.equal(shellScriptOf(['rm', 'a file.md']), "rm 'a file.md'");
  assert.equal(shellScriptOf('ls'), 'ls');
  assert.ok(write(shellScriptOf(['rm', 'research/a b.md'])).startsWith('research/a b.md'));
});
