#!/bin/sh
# Install the cdpkit commit-identity git hooks.
#
# Usage:
#   ./scripts/install-hooks.sh            # this clone
#   ./scripts/install-hooks.sh <repo-dir> # another repository

set -eu

PKG="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${1:-$PKG}"
HOOKS="$(cd "$REPO" && git rev-parse --path-format=absolute --git-path hooks)"
mkdir -p "$HOOKS"

for hook in pre-commit pre-push; do
  target="$HOOKS/$hook"
  if [ -e "$target" ] && ! grep -q "cdpkit-managed" "$target"; then
    echo "$target already exists and is not managed by cdpkit; leaving it alone." >&2
    exit 1
  fi
  printf '#!/bin/sh\n# cdpkit-managed\nexec "%s/.githooks/%s" "$@"\n' "$PKG" "$hook" > "$target"
  chmod +x "$target"
  echo "installed $target"
done
