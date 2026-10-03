/**
 * Minimal git access for the research loop. The runner is injected so the
 * core stays free of child_process and vscode; `src/cli/nodeGit.ts` provides
 * the Node implementation used by both the CLI and the extension.
 */

export interface GitResult { code: number; stdout: string; stderr: string }
export interface GitRunner {
  run(args: string[]): Promise<GitResult>;
  /** Whether a path (absolute, or relative to the work tree) exists; used for git's internal state files. */
  exists(file: string): Promise<boolean>;
}
export interface NameStatus { status: string; path: string; from?: string }

export class LoopGit {
  constructor(private readonly runner: GitRunner) {}

  run(args: string[]): Promise<GitResult> { return this.runner.run(args); }

  /** Run and throw with git's own message on failure. */
  async must(args: string[]): Promise<string> {
    const result = await this.runner.run(args);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  }

  async head(): Promise<string | undefined> {
    const result = await this.runner.run(['rev-parse', '--verify', '-q', 'HEAD']);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async branch(): Promise<string | undefined> {
    const result = await this.runner.run(['symbolic-ref', '--short', '-q', 'HEAD']);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  async userEmail(): Promise<string | undefined> {
    const result = await this.runner.run(['config', 'user.email']);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  /** `git status --porcelain` lines for the given paths (all when empty). */
  async status(paths: string[] = [], untracked = true): Promise<Array<{ code: string; path: string }>> {
    const out = await this.must(['status', '--porcelain=v1', `--untracked-files=${untracked ? 'all' : 'no'}`, '--', ...paths]);
    return out.split('\n').filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/g, '').replace(/^.* -> /, '') }));
  }

  async conflicts(): Promise<string[]> {
    const out = await this.must(['diff', '--name-only', '--diff-filter=U']);
    return out.split('\n').filter(Boolean);
  }

  async operationInProgress(): Promise<'rebase' | 'merge' | undefined> {
    for (const [name, kind] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge']] as const) {
      const where = await this.runner.run(['rev-parse', '--git-path', name]);
      if (where.code === 0 && where.stdout.trim() && (await this.runner.exists(where.stdout.trim()))) return kind;
    }
    return undefined;
  }

  async revCount(range: string): Promise<number> {
    const result = await this.runner.run(['rev-list', '--count', range]);
    return result.code === 0 ? Number(result.stdout.trim()) || 0 : 0;
  }

  async refExists(ref: string): Promise<boolean> {
    return (await this.runner.run(['rev-parse', '--verify', '-q', ref])).code === 0;
  }

  async diffNameStatus(from: string, to: string, paths: string[]): Promise<NameStatus[]> {
    const out = await this.must(['diff', '--name-status', '-M', from, to, '--', ...paths]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [status, first, second] = line.split('\t');
      return status.startsWith('R') ? { status: 'R', from: first, path: second } : { status: status[0], path: first };
    });
  }

  async showFile(rev: string, file: string): Promise<string | undefined> {
    const result = await this.runner.run(['show', `${rev}:${file}`]);
    return result.code === 0 ? result.stdout : undefined;
  }

  /** Author emails of commits in `range` touching `paths`, merges included. */
  async authors(range: string, paths: string[]): Promise<string[]> {
    const result = await this.runner.run(['log', '--format=%ae', range, '--', ...paths]);
    return result.code === 0 ? [...new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean))] : [];
  }
}
