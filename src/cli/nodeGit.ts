import { exec, execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GitResult, GitRunner, LoopGit } from '../services/LoopGit';

/** Runs the system `git` in the project root; never throws on a non-zero exit. */
export class NodeGitRunner implements GitRunner {
  constructor(private readonly root: string) {}

  run(args: string[], input?: string): Promise<GitResult> {
    return new Promise((resolve) => {
      const child = execFile('git', args, { cwd: this.root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && !stderr ? error.message : '') });
      });
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  async exists(file: string): Promise<boolean> {
    try { await fs.access(path.resolve(this.root, file)); return true; } catch { return false; }
  }
}

/** A LoopGit for `root`, or undefined when `root` is not inside a git work tree. */
export async function openGit(root: string): Promise<LoopGit | undefined> {
  const git = new LoopGit(new NodeGitRunner(root));
  const inside = await git.run(['rev-parse', '--is-inside-work-tree']);
  return inside.code === 0 && inside.stdout.trim() === 'true' ? git : undefined;
}

/** Run a configured shell command (the LaTeX build for sync prepare --latex) in the project root. */
export function runShell(root: string): (command: string) => Promise<{ code: number; output: string }> {
  return (command) => new Promise((resolve) => {
    exec(command, { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` }));
  });
}
