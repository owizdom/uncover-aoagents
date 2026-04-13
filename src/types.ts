/**
 * Core types for uncover-aoagents — a minimal agent-orchestrator.
 *
 * Reverse-engineered from ComposioHQ/agent-orchestrator.
 * Source: https://github.com/ComposioHQ/agent-orchestrator
 */

/** Session identifier — used as filename, so must be filesystem-safe. */
export type SessionId = string;

/**
 * Session metadata — the observable state of one agent session.
 * Persisted as `key=value` pairs on disk, bash-readable.
 */
export interface SessionMetadata {
  /** Absolute path to this session's git worktree */
  worktree: string;
  /** Git branch this agent is working on */
  branch: string;
  /** Current lifecycle status: working | pr_open | merged | ci_failed | done */
  status: string;
  /** PR URL, populated by the gh wrapper when the agent runs `gh pr create` */
  pr?: string;
  /** Short commit hash of HEAD, populated by the git wrapper after `git commit` */
  commit?: string;
  /** Wall-clock timestamp when the session was created */
  createdAt?: string;
  /** Free-form label for the task the agent is working on */
  issue?: string;
}

/** Config for spawning a new session. */
export interface SpawnConfig {
  sessionId: SessionId;
  branch: string;
  /** Path to the git repo the agent will work in */
  repoPath: string;
  /** Default branch of the repo (usually main or master) */
  defaultBranch: string;
  /** Optional label to display for this session */
  issue?: string;
}

/** The result of spawning a worktree-backed workspace. */
export interface WorkspaceInfo {
  path: string;
  branch: string;
  sessionId: SessionId;
}
