#!/usr/bin/env bash
# Install cdpkit launcher aliases into the user's shell rc file.
#
# Usage:
#   ./scripts/install-aliases.sh
#   ./scripts/install-aliases.sh ~/.bashrc

set -e

if [ -n "$1" ]; then
  RC_FILE="$1"
else
  SHELL_NAME="$(basename "${SHELL:-bash}")"
  case "$SHELL_NAME" in
    zsh)  RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    *)
      echo "Unknown shell: $SHELL_NAME"
      echo "Pass your shell rc file explicitly: ./scripts/install-aliases.sh ~/.zshrc"
      exit 1
      ;;
  esac
fi

if [ -n "${BASH_VERSION:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  # zsh or other shell that does not set BASH_SOURCE
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

ALIASES_FILE="$SCRIPT_DIR/aliases.sh"

if [ ! -f "$RC_FILE" ]; then
  echo "$RC_FILE does not exist. Creating it."
  touch "$RC_FILE"
fi

if grep -q "cdpkit app launchers" "$RC_FILE" 2>/dev/null; then
  echo "cdpkit aliases are already installed in $RC_FILE"
  exit 0
fi

cat >> "$RC_FILE" <<EOF

# >>>> cdpkit app launchers >>>>
source "$ALIASES_FILE"
# <<<< cdpkit app launchers <<<<
EOF

echo "cdpkit aliases installed in $RC_FILE"
echo "Run 'source $RC_FILE' or open a new terminal to use them."
