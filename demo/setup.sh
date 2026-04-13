#!/usr/bin/env bash
# Sets up 3 parallel uncover sessions against a fresh scratch repo.
# Run this in Terminal 1, then open Terminal 2 for `uncover watch`.

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Clean any previous state from test runs.
rm -rf ~/.uncover
echo "cleaned ~/.uncover"

# 2. Build a scratch git repo to act as "the project".
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git init -q -b main
git config user.email demo@uncover.local
git config user.name "uncover demo"
echo "# scratch repo" > README.md
git add README.md
git commit -q -m "initial"
echo "scratch repo at: $SCRATCH"

# 3. Spawn 3 sessions in parallel, each on its own branch.
cd /Users/Apple/Desktop/uncover-aoagents

for i in 1 2 3; do
  npx tsx src/index.ts spawn "int-$i" \
    --branch "feat/INT-$i" \
    --repo "$SCRATCH" \
    --default-branch main \
    --issue "INT-$i" > /dev/null
  echo "spawned int-$i"
done

echo
echo "=== 3 sessions ready ==="
npx tsx src/index.ts list
echo
echo "NEXT:"
echo "  1. Open a second terminal and run:  cd /Users/Apple/Desktop/uncover-aoagents && npx tsx src/index.ts watch"
echo "  2. Come back here and run:          bash demo/simulate.sh"
