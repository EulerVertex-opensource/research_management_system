import * as os from 'os';
import * as path from 'path';

/**
 * Where a shell command would write inside the project, for chats that may
 * read but never edit (the teaching chat). It reads the command the way a
 * shell would split it (quotes, heredocs, redirections, `cd`, command
 * substitutions, `bash -c`) and knows how the common writing tools name their
 * targets. It is a guard against an agent editing by shell, not a sandbox:
 * where a target cannot be told (a variable, a script that writes with no
 * path), it counts as inside the project, and temporary folders as outside.
 */

/** One simple command: its words, the files it sends output to, and what it reads on stdin (heredocs, here-strings). */
interface SimpleCommand { words: string[]; outputs: string[]; stdin: string[] }

export interface ShellWriteOptions {
  /** The project root (absolute); without it relative paths count as inside and absolute ones as outside. */
  root?: string;
  /** The directory the command starts in (default: the root). */
  cwd?: string;
  /** Read a script the command runs (absolute path), to see whether it writes; undefined when unreadable. */
  readFile?: (absolute: string) => string | undefined;
}

/** Scripts of this extension; their own subcommands are judged by the caller, not here. */
const OWN_CLIS = /(?:^|\/)(?:research-loop|manuscript-writing|research-maintenance)\.cjs$/;
const INTERPRETER = /^(?:python[\d.]*|pypy[\d.]*|node|nodejs|perl|ruby|Rscript|julia|deno|bun|php|lua|sage)$/;
const SHELL = /^(?:bash|sh|zsh|dash|ksh)$/;
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'exec', 'nice', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', '{', '}']);
/** git subcommands that change the working tree, the index, or the repository. */
const GIT_WRITES = new Set(['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'switch', 'init', 'notes', 'update-index', 'update-ref', 'gc', 'prune', 'filter-branch', 'replace', 'submodule']);
/** Calls in a script that write, delete, or move files, or hand off to another program. */
const WRITE_API = new RegExp([
  String.raw`\bopen(?:Sync)?\s*\(?[^,)\n]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+>]`,
  String.raw`\.write(?:_text|_bytes)?\s*\(`,
  String.raw`\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|cpSync|renameSync|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|truncateSync|symlinkSync|linkSync|writeLines|saveRDS|savefig|to_csv|to_json|to_parquet|to_excel|subprocess|child_process|execSync|spawnSync|execFileSync)\b`,
  String.raw`\b(?:os\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|removedirs|symlink|link|truncate|system|popen)|shutil\.\w+|FileUtils\.\w+|File\.(?:delete|rename|write)|file\.(?:remove|rename|copy|create)|write\.\w+|np\.save\w*|Deno\.(?:write\w*|remove|rename|mkdir))\b`,
  String.raw`\.(?:unlink|rename|replace|touch|mkdir|rmdir)\s*\(`,
  String.raw`\bsystem\s*\(`,
].join('|'));
const STDOUT_WRITE = /\b(?:sys\.(?:stdout|stderr)|process\.(?:stdout|stderr)|\$?(?:STDOUT|STDERR|stdout|stderr))\.write\b/g;

export function projectShellWrite(script: string, options: ShellWriteOptions = {}): string | undefined {
  return scriptWrite(script, options, options.cwd ?? options.root, 0);
}

/** The script a shell tool runs: a string, or an argv array (`bash -lc "..."` gives its script). */
export function shellScriptOf(command: unknown): string {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const argv = command.map(String);
  const flag = argv.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
  if (SHELL.test(path.basename(argv[0] ?? '')) && flag > 0 && argv[flag + 1] !== undefined) return argv[flag + 1];
  return argv.map((arg) => (/^[\w./=:@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function scriptWrite(script: string, options: ShellWriteOptions, startCwd: string | undefined, depth: number): string | undefined {
  if (depth > 3) return undefined;
  const { commands, substitutions } = lex(script);
  for (const inner of substitutions) {
    const found = scriptWrite(inner, options, startCwd, depth + 1);
    if (found) return found;
  }
  let cwd = startCwd;
  for (const command of commands) {
    const found = commandWrite(command, options, cwd, depth);
    if (found) return found;
    const { verb, args } = verbOf(command.words);
    if (verb === 'cd' || verb === 'pushd') cwd = changeDir(args.find((arg) => !arg.startsWith('-')) ?? '~', cwd, options.root);
  }
  return undefined;
}

/** Where a path lies: inside the project, or outside it (an unknown path counts as inside). */
function inside(word: string, cwd: string | undefined, root: string | undefined): boolean {
  if (/^(?:"?\$\{?(?:TMPDIR|TMP|TEMP|TEMPDIR)\b|\$\(mktemp\b)/.test(word)) return false;
  let target = word;
  if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
  if (/[$\x60]/.test(target)) return true;
  if (!root) return !path.isAbsolute(target);
  if (!path.isAbsolute(target) && cwd === undefined) return true;
  const resolved = path.resolve(cwd ?? root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function changeDir(target: string, cwd: string | undefined, root: string | undefined): string | undefined {
  if (/^(?:"?\$\{?(?:TMPDIR|TMP|TEMP|TEMPDIR)\b|\$\(mktemp\b)/.test(target)) return os.tmpdir();
  let dir = target;
  if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1));
  if (/[$\x60]/.test(dir) || dir === '-') return undefined;
  if (path.isAbsolute(dir)) return path.resolve(dir);
  return cwd === undefined ? undefined : path.resolve(cwd, dir);
}

/** The program a command runs and its arguments, past environment assignments and wrappers. */
function verbOf(words: string[]): { verb: string; args: string[] } {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_]\w*=/.test(word) || PREFIXES.has(word) || word === '(' || word === ')') { index += 1; continue; }
    if (word === 'env') { index += 1; while (index < words.length && (words[index].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[index]))) index += 1; continue; }
    if (word === 'timeout') { index += 1; while (index < words.length && words[index].startsWith('-')) index += 1; index += 1; continue; }
    break;
  }
  const verb = path.basename(words[index] ?? '');
  return { verb: verb === 'gsed' ? 'sed' : verb, args: words.slice(index + 1) };
}

const operands = (args: string[]) => args.filter((arg) => arg && arg !== '-' && !arg.startsWith('-'));

/** Operands, skipping the values of the options listed (`-e X`); `--opt=value` carries its own. */
function operandsSkipping(args: string[], valued: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valued.includes(arg)) { index += 1; continue; }
    if (arg && arg !== '-' && !arg.startsWith('-')) result.push(arg);
  }
  return result;
}

function commandWrite(command: SimpleCommand, options: ShellWriteOptions, cwd: string | undefined, depth: number): string | undefined {
  const { root } = options;
  const isInside = (word: string) => inside(word, cwd, root);
  const hit = (targets: string[], how: string) => { const target = targets.find(isInside); return target === undefined ? undefined : `${target} (${how})`; };
  const output = hit(command.outputs, 'output redirection');
  if (output) return output;
  const { verb, args } = verbOf(command.words);
  if (!verb) return undefined;
  switch (verb) {
    case 'rm': case 'rmdir': case 'unlink': case 'shred': case 'mv': case 'tee': case 'sponge':
    case 'ed': case 'ex': case 'vi': case 'vim': case 'nvim': case 'nano': case 'emacs':
      return hit(operandsSkipping(args, ['-c', '-S', '-u', '--cmd']), verb);
    case 'touch':
      return hit(operandsSkipping(args, ['-r', '-d', '-t']), verb);
    case 'awk': case 'gawk': case 'mawk': case 'nawk': {
      const program = args.find((arg, at) => !arg.startsWith('-') && !['-f', '-v', '-F'].includes(args[at - 1] ?? '')) ?? '';
      if (/\bsystem\s*\(/.test(program)) return `an ${verb} program that runs commands`;
      return hit([...program.matchAll(/\bprintf?\b[^;}]*?>>?\s*"([^"]+)"/g)].map((match) => match[1]), verb);
    }
    case 'curl': {
      const out = args.flatMap((arg, at) => (arg === '-o' || arg === '--output' ? [args[at + 1]] : arg.startsWith('--output=') ? [arg.slice(9)] : []));
      return hit([...out, ...(args.some((arg) => arg === '-O' || arg === '--remote-name' || /^-[a-zA-Z]*O$/.test(arg)) ? ['.'] : [])], verb);
    }
    case 'wget': {
      const named = args.flatMap((arg, at) => (['-O', '-P', '--output-document', '--directory-prefix'].includes(arg) ? [args[at + 1]] : []));
      return hit(named.length ? named : ['.'], verb);
    }
    case 'tar': case 'bsdtar': {
      // Old-style bundled flags (tar xzf a.tgz) or dashed ones (-x, -czf).
      const flags = [...(args[0] && /^[A-Za-z]+$/.test(args[0]) ? [args[0]] : []), ...args.filter((arg) => /^-[A-Za-z]+$/.test(arg))].join('');
      const valueOf = (option: string) => args[args.indexOf(option) + 1];
      if (/x/.test(flags) || args.includes('--extract')) return hit([args.includes('-C') ? valueOf('-C') : '.'], 'tar -x');
      if (/[cru]/.test(flags) || args.includes('--create')) return hit(args.includes('-f') ? [valueOf('-f')] : [], 'tar -c');
      return undefined;
    }
    case 'unzip':
      return hit([args.includes('-d') ? args[args.indexOf('-d') + 1] : '.'], verb);
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      if (verb === 'bun' && !['install', 'i', 'add', 'remove', 'rm', 'update'].includes(args[0])) break;
      return ['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'link', 'init'].includes(args[0]) ? hit(['.'], `${verb} ${args[0]}`) : undefined;
    case 'mkdir':
      return hit(operandsSkipping(args, ['-m']), verb);
    case 'truncate':
      return hit(operandsSkipping(args, ['-s', '-r']), verb);
    case 'chmod': case 'chown': case 'chgrp':
      return hit(operands(args).slice(1), verb);
    case 'cp': case 'ln': case 'install': case 'rsync': {
      const into = args.findIndex((arg) => arg === '-t');
      const named = into >= 0 ? args[into + 1] : args.find((arg) => arg.startsWith('--target-directory='))?.slice('--target-directory='.length);
      if (verb === 'install' && args.includes('-d')) return hit(operands(args), verb);
      const rest = operandsSkipping(args, ['-t', '-m', '-o', '-g', '-e', '--exclude', '--include', '-S']);
      const destination = named ?? (rest.length > 1 ? rest[rest.length - 1] : undefined);
      if (!destination || (verb === 'rsync' && /^[^/]*:/.test(destination))) return undefined;
      return hit([destination], verb);
    }
    case 'dd':
      return hit(args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice(3)), verb);
    case 'sed': {
      if (!args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'))) return undefined;
      const scripted = args.some((arg) => ['-e', '-f', '--expression', '--file'].includes(arg) || /^--(?:expression|file)=/.test(arg));
      const files = operandsSkipping(args, ['-e', '-f', '--expression', '--file']);
      return hit(scripted ? files : files.slice(1), 'sed -i');
    }
    case 'patch': {
      const dir = args[args.indexOf('-d') + 1];
      const out = args.indexOf('-o') >= 0 ? args[args.indexOf('-o') + 1] : undefined;
      if (out) return hit([out], verb);
      return hit([args.includes('-d') && dir ? dir : '.', ...operandsSkipping(args, ['-d', '-i', '-p', '-r'])], verb);
    }
    case 'apply_patch': {
      const targets = [...[...command.stdin, ...args].join('\n').matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)].map((match) => match[1].trim());
      return hit(targets, verb);
    }
    case 'git': {
      let dir = '.';
      let index = 0;
      while (index < args.length && args[index].startsWith('-')) {
        if (args[index] === '-C') { dir = args[index + 1] ?? '.'; index += 2; } else if (args[index] === '-c') index += 2; else index += 1;
      }
      const sub = args[index];
      const rest = args.slice(index + 1);
      const flags = rest.filter((arg) => arg.startsWith('-'));
      const writes = GIT_WRITES.has(sub)
        || (sub === 'stash' && !['list', 'show'].includes(rest[0] ?? 'push'))
        || (sub === 'branch' && (operands(rest).length > 0 || flags.some((flag) => /^-[dDmMcCf]$|^--(?:delete|move|copy|force|set-upstream-to|unset-upstream)/.test(flag))))
        || (sub === 'tag' && (operands(rest).length > 0 || flags.some((flag) => /^-[ds]$|^--delete/.test(flag))))
        || (sub === 'worktree' && rest[0] !== 'list')
        || (sub === 'remote' && ['add', 'remove', 'rm', 'rename', 'set-url', 'prune'].includes(rest[0]))
        || (sub === 'config' && !flags.some((flag) => /^--(?:get|list|show)|^-l$/.test(flag)) && operands(rest).length > 1);
      return writes ? hit([dir], `git ${sub}`) : undefined;
    }
    case 'find': {
      const start = [];
      for (const arg of args) { if (arg.startsWith('-') || arg === '(' || arg === '!') break; start.push(arg); }
      const points = start.length ? start : ['.'];
      if (args.includes('-delete')) return hit(points, 'find -delete');
      for (let index = 0; index < args.length; index += 1) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[index])) continue;
        const end = args.findIndex((arg, at) => at > index && (arg === ';' || arg === '\\;' || arg === '+'));
        const inner = args.slice(index + 1, end < 0 ? undefined : end);
        for (const point of points) {
          const found = commandWrite({ words: inner.map((word) => word.replace(/\{\}/g, `${point}/f`)), outputs: [], stdin: [] }, options, cwd, depth);
          if (found) return found;
        }
      }
      return undefined;
    }
    case 'xargs': {
      const valued = ['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs'];
      let index = 0;
      let placeholder: string | undefined;
      while (index < args.length && args[index].startsWith('-')) {
        if (args[index] === '-I') placeholder = args[index + 1];
        index += valued.includes(args[index]) ? 2 : 1;
      }
      const inner = args.slice(index).map((word) => (placeholder ? word.split(placeholder).join('$XARGS') : word));
      return commandWrite({ words: placeholder ? inner : [...inner, '$XARGS'], outputs: [], stdin: [] }, options, cwd, depth);
    }
    case 'eval':
      return scriptWrite(args.join(' '), options, cwd, depth + 1);
    case 'source': case '.':
      return scriptFileWrite(args[0], options, cwd, depth);
  }
  if (SHELL.test(verb)) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag >= 0) return scriptWrite(args[flag + 1] ?? '', options, cwd, depth + 1);
    const file = operands(args)[0];
    return file ? scriptFileWrite(file, options, cwd, depth) : scriptWrite(command.stdin.join('\n'), options, cwd, depth + 1);
  }
  if (INTERPRETER.test(verb)) return interpreterWrite(verb, args, command.stdin, options, cwd);
  return undefined;
}

function scriptFileWrite(file: string | undefined, options: ShellWriteOptions, cwd: string | undefined, depth: number): string | undefined {
  if (!file || !options.readFile || /[$\x60]/.test(file)) return undefined;
  const text = options.readFile(path.resolve(cwd ?? options.root ?? process.cwd(), file));
  return text === undefined ? undefined : scriptWrite(text, options, cwd, depth + 1);
}

/** A script an interpreter runs (inline, on stdin, or from a file) that writes files, unless every path it names is outside the project. */
function interpreterWrite(verb: string, args: string[], stdin: string[], options: ShellWriteOptions, cwd: string | undefined): string | undefined {
  const inline: string[] = [];
  let file: string | undefined;
  let module = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['-c', '-e', '-E', '-p', '--eval', '--print', '-r'].includes(arg) || (verb.startsWith('perl') && /^-[a-zA-Z]*[eE]$/.test(arg))) { inline.push(args[index + 1] ?? ''); index += 1; continue; }
    if (arg === '-m') { module = true; break; }
    if (verb.startsWith('perl') && /^-[a-zA-Z]*i/.test(arg)) {
      const files = operandsSkipping(args.slice(index + 1), ['-e', '-E']);
      const targets = inline.length || args.slice(index + 1).some((item) => item === '-e' || item === '-E') ? files : files.slice(1);
      const target = targets.find((item) => inside(item, cwd, options.root));
      if (target) return `${target} (perl -i)`;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (!inline.length && !file) { file = arg; break; }
  }
  if (module) return undefined;
  if (file && OWN_CLIS.test(file)) return undefined;
  const code = [...inline, ...(file ? [] : stdin)];
  if (file && file !== '-' && options.readFile && !/[$\x60]/.test(file)) {
    const text = options.readFile(path.resolve(cwd ?? options.root ?? process.cwd(), file));
    if (text !== undefined) code.push(text);
  }
  const text = code.join('\n').replace(STDOUT_WRITE, '');
  if (!text || !WRITE_API.test(text)) return undefined;
  const paths = [...text.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((match) => match[2]).filter((value) => value && !/\s/.test(value) && (value.includes('/') || /\.[A-Za-z]\w{0,5}$/.test(value)));
  const target = paths.find((value) => inside(value, cwd, options.root));
  if (target) return `${target} (${verb} script)`;
  return paths.length ? undefined : `a ${verb} script that writes files without naming a path outside the project`;
}

/**
 * Split a shell script into simple commands: quotes, escapes, comments,
 * separators (; && || | & newline, parentheses), redirections, and heredocs.
 * Command substitutions ($(...) and backticks) stay in their word and are also
 * returned, to be read as scripts of their own.
 */
function lex(script: string): { commands: SimpleCommand[]; substitutions: string[] } {
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  const fresh = (): SimpleCommand => ({ words: [], outputs: [], stdin: [] });
  let current = fresh();
  let word = '';
  let inWord = false;
  let pending: 'out' | 'in' | 'herestring' | 'heredoc' | undefined;
  let stripTabs = false;
  const heredocs: Array<{ delimiter: string; strip: boolean; command: SimpleCommand }> = [];
  const endWord = () => {
    if (!inWord) return;
    if (pending === 'out') current.outputs.push(word);
    else if (pending === 'herestring') current.stdin.push(word);
    else if (pending === 'heredoc') heredocs.push({ delimiter: word, strip: stripTabs, command: current });
    else if (pending !== 'in') current.words.push(word);
    pending = undefined;
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (current.words.length || current.outputs.length) commands.push(current);
    current = fresh();
  };
  /** Index just past the `)` closing a `$(` that opens at `start`. */
  const closeParen = (start: number) => {
    let depthCount = 1;
    let quote: string | undefined;
    let index = start;
    for (; index < script.length && depthCount > 0; index += 1) {
      const char = script[index];
      if (quote) { if (char === '\\' && quote === '"') index += 1; else if (char === quote) quote = undefined; continue; }
      if (char === '\\') { index += 1; continue; }
      if (char === '\'' || char === '"') quote = char;
      else if (char === '(') depthCount += 1;
      else if (char === ')') depthCount -= 1;
    }
    return index;
  };
  const substitution = (index: number): number => {
    if (script[index] === '`') {
      let end = index + 1;
      while (end < script.length && script[end] !== '`') end += script[end] === '\\' ? 2 : 1;
      substitutions.push(script.slice(index + 1, end));
      word += script.slice(index, end + 1);
      inWord = true;
      return end + 1;
    }
    const end = closeParen(index + 2);
    substitutions.push(script.slice(index + 2, end - 1));
    word += script.slice(index, end);
    inWord = true;
    return end;
  };
  let index = 0;
  while (index < script.length) {
    const char = script[index];
    const next = script[index + 1];
    if (char === '\\') {
      if (next === '\n') { index += 2; continue; }
      word += next ?? '';
      inWord = true;
      index += 2;
      continue;
    }
    if (char === '\'') {
      const end = script.indexOf('\'', index + 1);
      word += script.slice(index + 1, end < 0 ? undefined : end);
      inWord = true;
      index = end < 0 ? script.length : end + 1;
      continue;
    }
    if (char === '"') {
      inWord = true;
      index += 1;
      while (index < script.length && script[index] !== '"') {
        if (script[index] === '\\' && index + 1 < script.length) {
          const escaped = script[index + 1];
          word += '"\\$`\n'.includes(escaped) ? (escaped === '\n' ? '' : escaped) : `\\${escaped}`;
          index += 2;
        } else if ((script[index] === '$' && script[index + 1] === '(') || script[index] === '`') index = substitution(index);
        else word += script[index++];
      }
      index += 1;
      continue;
    }
    if ((char === '$' && next === '(') || char === '`') { index = substitution(index); continue; }
    if (char === '#' && !inWord) { while (index < script.length && script[index] !== '\n') index += 1; continue; }
    if (char === '\n') {
      endCommand();
      index += 1;
      // Heredoc bodies follow the line that opened them.
      while (heredocs.length) {
        const doc = heredocs.shift()!;
        const body: string[] = [];
        while (index < script.length) {
          const lineEnd = script.indexOf('\n', index);
          const line = script.slice(index, lineEnd < 0 ? undefined : lineEnd);
          index = lineEnd < 0 ? script.length : lineEnd + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
          body.push(line);
        }
        doc.command.stdin.push(body.join('\n'));
      }
      continue;
    }
    if (char === ';' || char === '(' || char === ')') { endCommand(); index += char === ';' && next === ';' ? 2 : 1; continue; }
    if (char === '|') { endCommand(); index += next === '|' || next === '&' ? 2 : 1; continue; }
    if (char === '&' && next === '&') { endCommand(); index += 2; continue; }
    if (char === '&' && next === '>') { endWord(); pending = 'out'; index += script[index + 2] === '>' ? 3 : 2; continue; }
    if (char === '&') { endCommand(); index += 1; continue; }
    if (char === '>' || char === '<') {
      // A file descriptor written right before the operator (2>) is part of it.
      if (inWord && /^\d+$/.test(word) && !/\s/.test(script[index - 1] ?? ' ')) { word = ''; inWord = false; } else endWord();
      if (char === '<') {
        if (next === '<' && script[index + 2] === '<') { pending = 'herestring'; index += 3; }
        else if (next === '<') { pending = 'heredoc'; stripTabs = script[index + 2] === '-'; index += stripTabs ? 3 : 2; }
        else { pending = 'in'; index += next === '&' || next === '>' ? 2 : 1; }
        continue;
      }
      if (next === '&') {
        // >&2, >&-: duplicating a descriptor writes no file.
        let end = index + 2;
        while (/[\d-]/.test(script[end] ?? '')) end += 1;
        if (end > index + 2) { index = end; continue; }
        pending = 'out';
        index += 2;
        continue;
      }
      pending = 'out';
      index += next === '>' || next === '|' ? 2 : 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') { endWord(); index += 1; continue; }
    word += char;
    inWord = true;
    index += 1;
  }
  endCommand();
  return { commands, substitutions };
}
