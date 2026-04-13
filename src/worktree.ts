/**
 * Git worktree spawner with 3-deep base-ref fallback.
 *
 * The trick (adapted from agent-orchestrator/packages/plugins/workspace-worktree/src/index.ts):
 *
 *   Each agent gets its own `git worktree` — not a clone, not a tarball.
 *   50 agents = 50 worktrees on the same .git database. Cheap, fast, isolated.
 *
 *   Base-ref resolution is the underappreciated part. Online, offline, dupe
 *   branches — it all Just Works because of a 3-deep fallback:
 *
 *     1. origin/<branch>        (remote feature branch if it exists)
 *     2. origin/<defaultBranch> (latest main from remote)
 *     3. refs/heads/<defaultBranch> (local main — works offline)
 *
 *   And if `git worktree add -b` fails because the branch already exists,
 *   it silently falls through to `git worktree add` + `git checkout <branch>`
 *   rather than crashing. Boring but load-bearing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpawnConfig, WorkspaceInfo } from "./types.js";

const execFileAsync = promisify(execFile);

/** Path segments that end up on disk must not contain path traversal. */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_.-]+$/;

function assertSafe(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
}

/** Run a git command in a given directory. Returns trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000 });
  return stdout.trimEnd();
}

async function hasOriginRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, "remote", "get-url", "origin");
    return true;
  } catch {
    return false;
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * 3-deep base-ref fallback. This is the reason uncover-aoagents works offline,
 * online, and on repos where the feature branch already exists remotely.
 */
async function resolveBaseRef(
  repoPath: string,
  defaultBranch: string,
  branch: string,
): Promise<string> {
  const hasOrigin = await hasOriginRemote(repoPath);

  if (hasOrigin) {
    const remoteBranch = `origin/${branch}`;
    if (await refExists(repoPath, remoteBranch)) return remoteBranch;

    const remoteDefault = `origin/${defaultBranch}`;
    if (await refExists(repoPath, remoteDefault)) return remoteDefault;
  }

  const localDefault = `refs/heads/${defaultBranch}`;
  if (await refExists(repoPath, localDefault)) return localDefault;

  throw new Error(
    `unable to resolve base ref for "${branch}" — is "${defaultBranch}" the right default branch?`,
  );
}

/** Default base dir for worktrees. Overridable via constructor arg. */
export function defaultWorktreeBaseDir(): string {
  return join(homedir(), ".uncover", "worktrees");
}

export async function createWorktree(
  cfg: SpawnConfig,
  worktreeBaseDir: string = defaultWorktreeBaseDir(),
): Promise<WorkspaceInfo> {
  assertSafe(cfg.sessionId, "sessionId");

  const worktreePath = join(worktreeBaseDir, cfg.sessionId);
  mkdirSync(worktreeBaseDir, { recursive: true });

  // Best-effort fetch so base refs reflect remote state.
  if (await hasOriginRemote(cfg.repoPath)) {
    try {
      await git(cfg.repoPath, "fetch", "origin", "--quiet");
    } catch {
      // Offline? That's fine — we'll fall back to local refs.
    }
  }

  const baseRef = await resolveBaseRef(cfg.repoPath, cfg.defaultBranch, cfg.branch);

  try {
    await git(cfg.repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) {
      throw new Error(`failed to create worktree for "${cfg.branch}": ${msg}`);
    }
    // Branch already exists — create worktree and check out the existing branch.
    await git(cfg.repoPath, "worktree", "add", worktreePath, baseRef);
    try {
      await git(worktreePath, "checkout", cfg.branch);
    } catch (checkoutErr) {
      // Best-effort cleanup so we don't leave an orphaned worktree.
      try {
        await git(cfg.repoPath, "worktree", "remove", "--force", worktreePath);
      } catch {
        /* swallow */
      }
      throw checkoutErr;
    }
  }

  return {
    path: worktreePath,
    branch: cfg.branch,
    sessionId: cfg.sessionId,
  };
}

/**
 * Remove a worktree. We intentionally do NOT delete the branch itself —
 * agent-orchestrator documents why: deleting branches risks nuking
 * pre-existing local branches that happen to match the session name.
 */
export async function destroyWorktree(workspacePath: string): Promise<void> {
  try {
    const gitCommonDir = await git(
      workspacePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const repoPath = join(gitCommonDir, "..");
    await git(repoPath, "worktree", "remove", "--force", workspacePath);
  } catch {
    if (existsSync(workspacePath)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  }
}
