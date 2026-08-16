#!/usr/bin/env bash
# Run the release gates the way CI sees them: in a throwaway clone that has
# NO generated artifacts (@cds-models, the .js/.d.ts twins next to the .ts
# sources, node_modules). A working tree that has been built and tested for
# weeks hides every "this file only exists locally" defect; this does not.
#
#   bash scripts/check-fresh-tree.sh            # HEAD + uncommitted changes
#   bash scripts/check-fresh-tree.sh --committed # HEAD only, as a tag would build
#
# Slow on purpose (fresh npm ci + the full gate set). Run it before tagging.
set -uo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=${TMPDIR:-/tmp}/nightgate-fresh-tree
COMMITTED_ONLY=${1:-}

rm -rf "$WORK"
echo "==> cloning HEAD into $WORK"
git clone --quiet --no-hardlinks "$SRC" "$WORK" || exit 1
cd "$WORK" || exit 1

if [ "$COMMITTED_ONLY" != "--committed" ]; then
  PATCH=$WORK.patch
  ( cd "$SRC" && git diff HEAD ) > "$PATCH"
  if [ -s "$PATCH" ]; then
    git apply "$PATCH" || { echo "==> FAILED to apply working-tree changes"; exit 1; }
    echo "==> applied uncommitted working-tree changes"
  fi
fi

echo "==> $(git rev-parse --short HEAD), version $(node -p "require('./package.json').version")"

npm ci || { echo "==> npm ci FAILED"; exit 1; }
CI=true NODE_ENV=test npm run check:release
RC=$?
echo "==> check:release exit=$RC (tree: $WORK)"
exit $RC
