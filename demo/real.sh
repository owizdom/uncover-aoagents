#!/usr/bin/env bash
# =============================================================================
# REAL DEMO — 3 Claude Code agents work in parallel on @owizdom's bobIsAlive repo.
#
# Unlike demo/simulate.sh (which fires the bash helper directly), this script
# spawns actual headless `claude -p` processes in isolated git worktrees.
# Each agent edits the README, commits, and the `uncover` git shim observes
# every commit as it happens.
#
# Expected runtime: ~60-90 seconds for all 3 agents to complete.
#
# Prerequisites:
#   - claude CLI installed and authenticated
#   - /Users/Apple/Desktop/all/swarm-escrow exists and is a clean git repo
#
# Usage:
#   Terminal 1:   bash demo/real.sh
#   Terminal 2:   npx tsx src/index.ts watch   (leave running during the run)
# =============================================================================

set -euo pipefail

TARGET_REPO="/Users/Apple/Desktop/all/swarm-escrow"
UNCOVER_ROOT="/Users/Apple/Desktop/uncover-aoagents"

# -----------------------------------------------------------------------------
# Preflight
# -----------------------------------------------------------------------------

if ! command -v claude >/dev/null 2>&1; then
  echo "error: claude CLI not found on PATH" >&2
  exit 1
fi

if [[ ! -d "$TARGET_REPO/.git" ]]; then
  echo "error: $TARGET_REPO is not a git repo" >&2
  exit 1
fi

cd "$UNCOVER_ROOT"

# -----------------------------------------------------------------------------
# Reset any previous uncover state so the demo starts cold.
# -----------------------------------------------------------------------------

rm -rf ~/.uncover
echo "[setup] cleaned ~/.uncover"

# Also prune any leftover uncover worktrees from previous runs on the target
# repo. We only touch worktrees whose path contains /.uncover/ so we never
# disturb the user's real worktrees.
#
# We disable pipefail/errexit for this block because `grep` legitimately
# exits 1 when there are no matches (the common case on a fresh run).
set +eo pipefail
stale_wts="$(git -C "$TARGET_REPO" worktree list --porcelain 2>/dev/null \
  | awk '/^worktree / {print $2}' \
  | grep -F "/.uncover/")"
if [[ -n "$stale_wts" ]]; then
  while IFS= read -r wt; do
    git -C "$TARGET_REPO" worktree remove --force "$wt" 2>/dev/null
  done <<< "$stale_wts"
fi
git -C "$TARGET_REPO" worktree prune 2>/dev/null
set -eo pipefail
echo "[setup] pruned stale uncover worktrees"

# Delete any leftover uncover feature branches from previous runs.
for b in feat/uncover-docs-alpha feat/uncover-docs-beta feat/uncover-docs-gamma; do
  git -C "$TARGET_REPO" branch -D "$b" 2>/dev/null || true
done

# -----------------------------------------------------------------------------
# Spawn 3 uncover sessions, one per task.
# -----------------------------------------------------------------------------

echo
echo "[spawn] creating 3 worktree-isolated sessions on $TARGET_REPO ..."

npx tsx src/index.ts spawn alpha \
  --branch feat/uncover-docs-alpha \
  --repo "$TARGET_REPO" \
  --default-branch main \
  --issue "docs: dev-mode section" > /dev/null

npx tsx src/index.ts spawn beta \
  --branch feat/uncover-docs-beta \
  --repo "$TARGET_REPO" \
  --default-branch main \
  --issue "docs: glossary section" > /dev/null

npx tsx src/index.ts spawn gamma \
  --branch feat/uncover-docs-gamma \
  --repo "$TARGET_REPO" \
  --default-branch main \
  --issue "docs: credits section" > /dev/null

echo "[spawn] alpha, beta, gamma ready"
npx tsx src/index.ts list
echo

# -----------------------------------------------------------------------------
# Kick off 3 headless Claude Code agents in parallel.
# Each runs in its own worktree with:
#   - PATH prepended by ~/.uncover/bin (so the git shim intercepts commits)
#   - UNCOVER_SESSION set so the shim knows which session to update
#
# --dangerously-skip-permissions    don't prompt for edit/bash approval
#
# NOTE: we deliberately do NOT pass --bare. --bare disables keychain reads,
# which means Claude can only auth via $ANTHROPIC_API_KEY. Most Max-plan users
# auth via OAuth in the keychain, so --bare breaks them. Default mode uses
# the keychain and Just Works.
# -----------------------------------------------------------------------------

UNCOVER_DATA_DIR=~/.uncover/sessions
UNCOVER_BIN=~/.uncover/bin
AGENT_PATH="$UNCOVER_BIN:$PATH"

run_agent() {
  local session="$1"
  local prompt="$2"
  local worktree=~/.uncover/worktrees/"$session"
  local log=~/.uncover/$session.log

  (
    cd "$worktree"
    export UNCOVER_DATA_DIR
    export UNCOVER_SESSION="$session"
    export PATH="$AGENT_PATH"
    claude -p \
      --dangerously-skip-permissions \
      "$prompt" \
      > "$log" 2>&1
  ) &
}

PROMPT_ALPHA='Edit README.md in the current directory. Append a new section at the very bottom titled "## Dev mode" followed by exactly one paragraph that says: "Run the dashboard locally with `npm run dev` from the `frontend/` directory." Do not touch any other file. When you are done with the edit, run this exact shell command: git add README.md && git commit -m "docs: add dev mode section"'

PROMPT_BETA='Edit README.md in the current directory. Append a new section at the very bottom titled "## Glossary" followed by exactly three bullet points defining: TEE (Trusted Execution Environment), Starknet (a Layer 2 ZK-rollup on Ethereum), and swarm (multi-agent coordination). Do not touch any other file. When you are done with the edit, run this exact shell command: git add README.md && git commit -m "docs: add glossary"'

PROMPT_GAMMA='Edit README.md in the current directory. Append a new section at the very bottom titled "## Credits" followed by a single line: "Built by @owizdom. TEE infra by EigenCompute." Do not touch any other file. When you are done with the edit, run this exact shell command: git add README.md && git commit -m "docs: add credits"'

echo "[run] launching 3 parallel claude -p processes (this takes ~60-90s)"
echo "      keep Terminal 2 running \"npx tsx src/index.ts watch\" to see the cascade"
echo

run_agent alpha "$PROMPT_ALPHA"
run_agent beta  "$PROMPT_BETA"
run_agent gamma "$PROMPT_GAMMA"

wait
echo "[run] all agents finished"

# -----------------------------------------------------------------------------
# Final state
# -----------------------------------------------------------------------------

echo
echo "=== final state ==="
npx tsx src/index.ts list
echo

echo "=== diffs (what the 3 agents actually changed) ==="
for s in alpha beta gamma; do
  echo "--- $s ---"
  git -C ~/.uncover/worktrees/"$s" --no-pager log --oneline -1 2>/dev/null || echo "(no commit)"
  git -C ~/.uncover/worktrees/"$s" --no-pager diff HEAD~1 HEAD -- README.md 2>/dev/null | head -20 || true
  echo
done

echo "logs at ~/.uncover/{alpha,beta,gamma}.log"
