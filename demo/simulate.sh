#!/usr/bin/env bash
# Simulates 3 agents independently running `gh pr create` and `gh pr merge`
# by invoking the same bash helper the shims use. This proves the end-to-end
# bash → metadata file → TypeScript reader loop without needing real agents.
#
# Keep `uncover watch` open in a second terminal while you run this — you'll
# see each session transition working → pr_open → merged in real time.

set -euo pipefail

export UNCOVER_DATA_DIR=~/.uncover/sessions
source ~/.uncover/bin/uncover-metadata-helper.sh

transition() {
  local session="$1" pr_url="$2" delay="$3"
  UNCOVER_SESSION="$session" update_uncover_metadata pr "$pr_url"
  UNCOVER_SESSION="$session" update_uncover_metadata status pr_open
  sleep "$delay"
  UNCOVER_SESSION="$session" update_uncover_metadata status merged
}

echo "simulating 3 agents opening and merging PRs..."
echo

# Fire the transitions with staggered timing so watch shows a cascade.
(transition int-1 "https://github.com/demo/repo/pull/101" 3) &
sleep 1
(transition int-2 "https://github.com/demo/repo/pull/102" 4) &
sleep 1
(transition int-3 "https://github.com/demo/repo/pull/103" 5) &

wait
echo
echo "=== final state ==="
cd /Users/Apple/Desktop/uncover-aoagents
npx tsx src/index.ts list
