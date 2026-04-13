#!/usr/bin/env node
/**
 * uncover-aoagents — a minimal reverse-engineered agent-orchestrator.
 *
 * CLI (binary name: `uncover`):
 *
 *   uncover spawn <session-id> --branch <branch> [--repo <path>] [--default-branch main]
 *       Create a git worktree, install the PATH shims, and print the exported
 *       env block to run an agent against the new worktree.
 *
 *   uncover list
 *       Show all known sessions and their current observed state (read from
 *       the bash-written metadata files).
 *
 *   uncover watch
 *       Poll every 2 seconds and pretty-print session state changes.
 *
 *   uncover destroy <session-id>
 *       Remove the worktree. Does not delete the branch.
 *
 * The point of this file is to be boring. The clever bits live in shims.ts,
 * worktree.ts, and metadata.ts. index.ts just glues them together.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createWorktree, destroyWorktree, defaultWorktreeBaseDir } from "./worktree.js";
import { installShims, uncoverBinDir, buildAgentPath } from "./shims.js";
import {
  ensureDataDir,
  listSessions,
  patchMetadata,
  readMetadata,
  writeMetadata,
} from "./metadata.js";
import type { SessionMetadata } from "./types.js";

const DATA_DIR = join(homedir(), ".uncover", "sessions");

interface ParsedArgs {
  _: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { _: positional, flags };
}

function usage(): void {
  console.log(`uncover — minimal agent-orchestrator in ~400 lines of TypeScript

Commands:
  uncover spawn <session-id> --branch <branch> [--repo <path>] [--default-branch main] [--issue <label>]
  uncover list
  uncover watch
  uncover destroy <session-id>

Environment variables the shims expect (set automatically by \`uncover spawn\`):
  UNCOVER_DATA_DIR   ${DATA_DIR}
  UNCOVER_SESSION    <session-id>
  PATH               ~/.uncover/bin:$PATH
`);
}

// =============================================================================
// Commands
// =============================================================================

async function cmdSpawn(args: ParsedArgs): Promise<void> {
  const sessionId = args._[1];
  if (!sessionId) throw new Error("session-id required: uncover spawn <session-id> --branch <b>");

  const branch = args.flags.branch;
  if (!branch) throw new Error("--branch required");

  const repoPath = args.flags.repo ?? process.cwd();
  const defaultBranch = args.flags["default-branch"] ?? "main";
  const issue = args.flags.issue;

  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`${repoPath} is not a git repo (no .git directory)`);
  }

  // 1. Install wrappers (idempotent — safe to run many times).
  const binDir = await installShims();

  // 2. Create the worktree.
  const workspace = await createWorktree({
    sessionId,
    branch,
    repoPath,
    defaultBranch,
    issue,
  });

  // 3. Write the initial session metadata. The bash wrappers will update
  //    this file in place when the agent runs gh pr create / git checkout -b.
  ensureDataDir(DATA_DIR);
  writeMetadata(DATA_DIR, sessionId, {
    worktree: workspace.path,
    branch: workspace.branch,
    status: "working",
    issue,
    createdAt: new Date().toISOString(),
  });

  // 4. Print the env block so the user can paste it into their agent runner.
  const agentPath = buildAgentPath(process.env.PATH);
  console.log(`
uncover session ready:
  session:      ${sessionId}
  worktree:     ${workspace.path}
  branch:       ${workspace.branch}
  metadata:     ${join(DATA_DIR, sessionId)}
  shim dir:     ${binDir}

Run your agent inside the worktree with:

  cd "${workspace.path}"
  export UNCOVER_DATA_DIR="${DATA_DIR}"
  export UNCOVER_SESSION="${sessionId}"
  export PATH="${agentPath}"

  # now run whatever coding agent you like:
  claude        # or: codex, aider, opencode, etc.

The gh/git shims will auto-observe \`gh pr create\`, \`gh pr merge\`, and
\`git checkout -b <branch>\` and write the results back to the session
metadata file. Run \`uncover list\` or \`uncover watch\` in another terminal
to see state updates in real time.
`);
}

function renderRow(id: string, m: SessionMetadata | null): string {
  if (!m) return `${id.padEnd(14)}  <missing metadata>`;
  const status = m.status.padEnd(10);
  const branch = (m.branch || "-").padEnd(20);
  const commit = (m.commit ?? "-").padEnd(9);
  const pr = m.pr ?? "-";
  return `${id.padEnd(14)}  ${status}  ${branch}  ${commit}  ${pr}`;
}

function renderTable(ids: string[]): string {
  const header =
    `${"SESSION".padEnd(14)}  ${"STATUS".padEnd(10)}  ` +
    `${"BRANCH".padEnd(20)}  ${"COMMIT".padEnd(9)}  PR`;
  const sep = "-".repeat(header.length);
  const rows = ids.map((id) => renderRow(id, readMetadata(DATA_DIR, id)));
  return [header, sep, ...rows].join("\n");
}

async function cmdList(): Promise<void> {
  const ids = listSessions(DATA_DIR);
  if (ids.length === 0) {
    console.log("no sessions yet. spawn one with: uncover spawn <id> --branch <b>");
    return;
  }
  console.log(renderTable(ids));
}

async function cmdWatch(): Promise<void> {
  let lastRender = "";
  const tick = (): void => {
    const ids = listSessions(DATA_DIR);
    const out = ids.length === 0 ? "no sessions yet" : renderTable(ids);
    if (out !== lastRender) {
      console.clear();
      console.log(`uncover watch — ${new Date().toLocaleTimeString()}\n`);
      console.log(out);
      lastRender = out;
    }
  };
  tick();
  setInterval(tick, 2_000);
}

async function cmdDestroy(args: ParsedArgs): Promise<void> {
  const sessionId = args._[1];
  if (!sessionId) throw new Error("session-id required: uncover destroy <session-id>");

  const meta = readMetadata(DATA_DIR, sessionId);
  if (!meta) {
    console.log(`no such session: ${sessionId}`);
    return;
  }

  if (meta.worktree) {
    await destroyWorktree(meta.worktree);
    console.log(`removed worktree: ${meta.worktree}`);
  }

  // Mark the session as destroyed rather than deleting the file, so `uncover
  // list` still shows a history of what ran.
  patchMetadata(DATA_DIR, sessionId, { status: "destroyed" });
  console.log(`session ${sessionId} destroyed. branch "${meta.branch}" was NOT deleted.`);
}

// =============================================================================
// Dispatch
// =============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  // Silence unused var: defaultWorktreeBaseDir is re-exported for library consumers
  void defaultWorktreeBaseDir;
  // Silence unused var: uncoverBinDir is re-exported for library consumers
  void uncoverBinDir;

  switch (cmd) {
    case "spawn":
      await cmdSpawn(args);
      break;
    case "list":
      await cmdList();
      break;
    case "watch":
      await cmdWatch();
      break;
    case "destroy":
      await cmdDestroy(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`uncover: ${msg}`);
  process.exit(1);
});
