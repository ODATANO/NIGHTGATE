#!/usr/bin/env bash
# Runs the release gates in a throwaway clone without generated files, as CI sees them.
# Run: bash scripts/check-fresh-tree.sh [--committed]  (--committed builds HEAD only, as a tag would)
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
  # Tracked changes AND untracked (not ignored) files: a new script that
  # package.json references must travel with the release commit, and this
  # gate is where that shows up (MODULE_NOT_FOUND otherwise).
  ( cd "$SRC" && git diff HEAD --binary ) > "$PATCH"
  if [ -s "$PATCH" ]; then
    git apply "$PATCH" || { echo "==> FAILED to apply working-tree changes"; exit 1; }
    echo "==> applied uncommitted working-tree changes"
  fi
  UNTRACKED=$( cd "$SRC" && git ls-files --others --exclude-standard )
  if [ -n "$UNTRACKED" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      mkdir -p "$(dirname "$f")" && cp "$SRC/$f" "$f"
    done <<< "$UNTRACKED"
    echo "==> copied untracked files: $(echo "$UNTRACKED" | wc -l | tr -d ' ') (they must be git-added for the release commit)"
    echo "$UNTRACKED" | sed 's/^/    /'
  fi
fi

echo "==> $(git rev-parse --short HEAD), version $(node -p "require('./package.json').version")"

npm ci || { echo "==> npm ci FAILED"; exit 1; }
CI=true NODE_ENV=test npm run check:release
RC=$?
echo "==> check:release exit=$RC (tree: $WORK)"
exit $RC
