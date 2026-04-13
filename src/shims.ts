/**
 * PATH-based gh/git shims — the hero trick from agent-orchestrator.
 *
 * === The trick ===
 *
 * Instead of building an SDK, patching agents, or requiring a coordination
 * protocol, agent-orchestrator installs fake `gh` and `git` binaries at
 * ~/.ao/bin/ and prepends that directory to the agent's PATH.
 *
 * Any tool that eventually shells out — Codex, Aider, OpenCode, your own
 * bash loop — runs through the wrapper transparently. When the agent does
 *
 *     gh pr create
 *
 * the wrapper calls real `gh`, parses the PR URL from the output, and
 * atomically writes it to the session's metadata file. The agent has no
 * idea it's being observed. Zero agent code modified.
 *
 * (Claude Code has its own PostToolUse hook system and doesn't need the
 * PATH shim, but the wrapper still works if PATH is set — they're
 * complementary, not exclusive.)
 *
 * === What gets observed ===
 *
 *   gh pr create   → parses the https://github.com/.../pull/N URL
 *                    → sets metadata `pr=<url>`, `status=pr_open`
 *   gh pr merge    → sets metadata `status=merged`
 *   git checkout -b <branch> / git switch -c <branch>
 *                  → sets metadata `branch=<branch>`
 *
 * All other commands pass through unchanged.
 *
 * === Why the wrapper is bash, not TypeScript ===
 *
 * Because the metadata files are plain `key=value` lines, bash can read
 * and write them with `grep`/`sed` — no JSON parser, no Node spawn on
 * every command. The wrappers are a few hundred bytes and add ~2ms of
 * overhead per git call.
 *
 * === Security notes ===
 *
 * Defensive posture adapted from upstream. Must not be bypassable by:
 *
 *   - Path traversal in $UNCOVER_SESSION  (e.g. `../../etc/passwd`)
 *   - Symlinks escaping $UNCOVER_DATA_DIR out of the allowlist
 *   - sed injection via & or | in the value
 *   - Newline injection creating new metadata keys
 *   - Recursive wrapper self-calls when $GH_PATH points at the shim dir
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Bumping this forces re-write of the wrappers on next setup. */
const WRAPPER_VERSION = "0.2.0-uncover";

const DEFAULT_PATH = "/usr/bin:/bin";
const PREFERRED_GH_BIN_DIR = "/usr/local/bin";

/** Where uncover installs its shims. Lazy so test mocks can swap homedir(). */
export function uncoverBinDir(): string {
  return join(homedir(), ".uncover", "bin");
}

/**
 * Build a PATH string with uncoverBinDir() prepended. This is what you
 * export to the agent's environment before spawning it.
 */
export function buildAgentPath(basePath: string | undefined): string {
  const inherited = (basePath ?? DEFAULT_PATH).split(":").filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string): void => {
    if (!entry || seen.has(entry)) return;
    out.push(entry);
    seen.add(entry);
  };
  add(uncoverBinDir());
  add(PREFERRED_GH_BIN_DIR);
  for (const e of inherited) add(e);
  return out.join(":");
}

// =============================================================================
// Shell wrapper scripts
// =============================================================================

/* eslint-disable no-useless-escape */

/**
 * Shared helper sourced by both wrappers. Provides:
 *
 *   update_uncover_metadata <key> <value>
 *
 * The function writes to $UNCOVER_DATA_DIR/$UNCOVER_SESSION and is defensive
 * against the injection vectors listed at the top of this file.
 */
const METADATA_HELPER = `#!/usr/bin/env bash
# uncover-metadata-helper — sourced by gh/git wrappers.
# Writes key=value pairs to \$UNCOVER_DATA_DIR/\$UNCOVER_SESSION atomically.

update_uncover_metadata() {
  local key="\$1" value="\$2"
  local data_dir="\${UNCOVER_DATA_DIR:-}"
  local session="\${UNCOVER_SESSION:-}"

  [[ -z "\$data_dir" || -z "\$session" ]] && return 0

  # Reject path traversal in session name
  case "\$session" in
    */* | *..*) return 0 ;;
  esac

  # data_dir must be under a trusted root
  case "\$data_dir" in
    "\$HOME"/.uncover/* | /tmp/*) ;;
    *) return 0 ;;
  esac

  local metadata_file="\$data_dir/\$session"

  # Canonicalize symlinks — prevents /tmp/../../home/user escapes
  local real_data_dir
  real_data_dir="\$(cd "\$data_dir" 2>/dev/null && pwd -P)" || return 0
  case "\$real_data_dir" in
    "\$HOME"/.uncover/* | "\$HOME"/.uncover | /tmp/*) ;;
    *) return 0 ;;
  esac

  [[ -f "\$metadata_file" ]] || return 0

  # Keys must be \`[a-zA-Z0-9_-]+\` — prevents sed injection
  [[ "\$key" =~ ^[a-zA-Z0-9_-]+$ ]] || return 0

  local temp_file="\${metadata_file}.tmp.\$\$"

  # Strip newlines from value to prevent line injection
  local clean_value
  clean_value="\$(printf '%s' "\$value" | tr -d '\\n')"

  # Escape sed metacharacters: & | \\
  local escaped_value
  escaped_value="\$(printf '%s' "\$clean_value" | sed 's/[&|\\\\]/\\\\&/g')"

  if grep -q "^\${key}=" "\$metadata_file" 2>/dev/null; then
    sed "s|^\${key}=.*|\${key}=\${escaped_value}|" "\$metadata_file" > "\$temp_file"
  else
    cp "\$metadata_file" "\$temp_file"
    printf '%s=%s\\n' "\$key" "\$clean_value" >> "\$temp_file"
  fi

  mv "\$temp_file" "\$metadata_file"
}
`;

/**
 * gh wrapper — intercepts \`gh pr create\` and \`gh pr merge\` only.
 * Everything else execs real gh without capturing output.
 */
const GH_WRAPPER = `#!/usr/bin/env bash
# uncover gh wrapper — observes PR creation without modifying agents.

bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"

# Remove our dir from PATH so \`command -v gh\` finds the real one
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"

real_gh=""
if [[ -n "\${GH_PATH:-}" && -x "\$GH_PATH" ]]; then
  gh_dir="\$(cd "\$(dirname "\$GH_PATH")" 2>/dev/null && pwd)"
  if [[ "\$gh_dir" != "\$bin_dir" ]]; then
    real_gh="\$GH_PATH"
  fi
fi
if [[ -z "\$real_gh" ]]; then
  real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"
fi
if [[ -z "\$real_gh" ]]; then
  echo "uncover-wrapper: gh not found in PATH" >&2
  exit 127
fi

# Load the metadata helper
source "\$bin_dir/uncover-metadata-helper.sh" 2>/dev/null || true

# Only capture output for commands we parse
case "\$1/\$2" in
  pr/create|pr/merge)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      case "\$1/\$2" in
        pr/create)
          pr_url="\$(echo "\$output" | grep -Eo 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
          if [[ -n "\$pr_url" ]]; then
            update_uncover_metadata pr "\$pr_url"
            update_uncover_metadata status pr_open
          fi
          ;;
        pr/merge)
          update_uncover_metadata status merged
          ;;
      esac
    fi

    exit \$exit_code
    ;;
  *)
    exec "\$real_gh" "\$@"
    ;;
esac
`;

/**
 * git wrapper — intercepts branch switching and commits. Everything else
 * execs real git. Only updates metadata on success (non-zero exit = no
 * change).
 *
 * Observation surface:
 *   git checkout -b <branch> / git switch -c <branch>
 *       → sets metadata `branch=<branch>`
 *   git commit ...  (success, inside a worktree with a prior HEAD)
 *       → sets metadata `commit=<short-hash>`, `status=committed`
 *
 * We call real_git (not the wrapper) for `rev-parse --short HEAD` so we
 * never recurse into the shim.
 */
const GIT_WRAPPER = `#!/usr/bin/env bash
# uncover git wrapper — observes branch switches and commits.

bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"

clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_git="\$(PATH="\$clean_path" command -v git 2>/dev/null)"

if [[ -z "\$real_git" ]]; then
  echo "uncover-wrapper: git not found in PATH" >&2
  exit 127
fi

source "\$bin_dir/uncover-metadata-helper.sh" 2>/dev/null || true

"\$real_git" "\$@"
exit_code=\$?

if [[ \$exit_code -eq 0 ]]; then
  case "\$1/\$2" in
    checkout/-b|switch/-c)
      update_uncover_metadata branch "\$3"
      ;;
  esac

  # Also observe \`git commit\`. We ask the real git for the new HEAD hash
  # directly (bypassing the wrapper) so we can't recurse into ourselves.
  if [[ "\$1" == "commit" ]]; then
    commit_hash="\$("\$real_git" rev-parse --short HEAD 2>/dev/null || true)"
    if [[ -n "\$commit_hash" ]]; then
      update_uncover_metadata commit "\$commit_hash"
      update_uncover_metadata status committed
    fi
  fi
fi

exit \$exit_code
`;

/* eslint-enable no-useless-escape */

// =============================================================================
// Installer
// =============================================================================

/**
 * Atomically write a file. Same pattern as metadata.ts but async —
 * two concurrent uncover processes racing to install shims must not
 * produce a half-written wrapper (which would be an unreadable script).
 */
async function atomicWriteFile(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp.${suffix}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await rename(tmpPath, filePath);
}

/**
 * Install the gh/git wrappers. Idempotent and versioned — re-running with
 * the same WRAPPER_VERSION is a no-op. Bump the constant to force a rewrite.
 */
export async function installShims(): Promise<string> {
  const dir = uncoverBinDir();
  await mkdir(dir, { recursive: true });

  const markerPath = join(dir, ".uncover-version");
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === WRAPPER_VERSION) needsUpdate = false;
  } catch {
    /* marker missing — first install */
  }

  if (needsUpdate) {
    await atomicWriteFile(join(dir, "uncover-metadata-helper.sh"), METADATA_HELPER, 0o755);
    await atomicWriteFile(join(dir, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(dir, "git"), GIT_WRAPPER, 0o755);
    // Write the version marker LAST — if we crash between wrapper writes,
    // the next run redoes them (safe: wrappers are idempotent).
    await atomicWriteFile(markerPath, WRAPPER_VERSION, 0o644);
  }

  return dir;
}
