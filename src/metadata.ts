/**
 * Atomic key=value metadata store for agent sessions.
 *
 * The trick (straight out of agent-orchestrator/packages/core/src/atomic-write.ts):
 *
 *     writeFileSync(tmpPath)  →  renameSync(tmpPath, realPath)
 *
 * rename() is atomic on POSIX, so N concurrent writers never produce torn
 * reads. The bash wrappers (shims.ts) and the TypeScript orchestrator both
 * write to the same files — this is why they can't step on each other.
 *
 * Format: one `key=value` per line. Bash-compatible on purpose, so the
 * wrapper scripts can read/write the same files without a JSON parser.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionId, SessionMetadata } from "./types.js";

/** Session IDs must be filesystem-safe and free of path traversal. */
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(id: SessionId): void {
  if (!VALID_SESSION_ID.test(id)) {
    throw new Error(`invalid session id: ${id} (must match ${VALID_SESSION_ID})`);
  }
}

/**
 * Atomically write a file. Temp name includes PID + timestamp so concurrent
 * writers inside the same process tree don't collide on the temp path.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/** Serialize a flat record to `key=value` lines. Newlines in values are stripped. */
function serialize(data: object): string {
  return (
    Object.entries(data as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, " ")}`)
      .join("\n") + "\n"
  );
}

/** Parse `key=value` lines back into a record. Ignores blank lines and comments. */
function parse(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Resolve the directory where session files live. Created on first use. */
export function ensureDataDir(dataDir: string): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

/** Full path to a single session's metadata file. */
function metadataPath(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, sessionId);
}

export function readMetadata(dataDir: string, sessionId: SessionId): SessionMetadata | null {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return null;
  const raw = parse(readFileSync(path, "utf-8"));
  return {
    worktree: raw.worktree ?? "",
    branch: raw.branch ?? "",
    status: raw.status ?? "unknown",
    pr: raw.pr,
    commit: raw.commit,
    createdAt: raw.createdAt,
    issue: raw.issue,
  };
}

export function writeMetadata(
  dataDir: string,
  sessionId: SessionId,
  metadata: SessionMetadata,
): void {
  ensureDataDir(dataDir);
  atomicWriteFileSync(metadataPath(dataDir, sessionId), serialize(metadata));
}

/** Merge a patch into an existing session's metadata. */
export function patchMetadata(
  dataDir: string,
  sessionId: SessionId,
  patch: Partial<SessionMetadata>,
): void {
  const existing = readMetadata(dataDir, sessionId) ?? {
    worktree: "",
    branch: "",
    status: "unknown",
  };
  writeMetadata(dataDir, sessionId, { ...existing, ...patch });
}

/** List all session IDs under the data directory. */
export function listSessions(dataDir: string): SessionId[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).filter((name) => VALID_SESSION_ID.test(name));
}
