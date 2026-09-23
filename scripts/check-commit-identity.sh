#!/bin/sh
# Reject commits that are not authored and committed as the shared maintainer identity.
#
# Usage:
#   scripts/check-commit-identity.sh                   # check the identity the next commit will use
#   scripts/check-commit-identity.sh <git log args...> # check existing commits, e.g. origin/main..HEAD

set -eu

NAME="CDPKit Maintainer"
EMAIL="maintainer@example.invalid"
ID="$NAME <$EMAIL>"

fail() {
  echo "commit identity check failed: $1" >&2
  echo "Commit as: git -c user.name=\"$NAME\" -c user.email=$EMAIL commit ..." >&2
  exit 1
}

if [ $# -eq 0 ]; then
  for role in AUTHOR COMMITTER; do
    ident="$(git var "GIT_${role}_IDENT")"
    case "$ident" in
      "$ID "*) ;;
      *) fail "$(echo "$role" | tr 'A-Z' 'a-z') would be ${ident% * *}" ;;
    esac
  done
  exit 0
fi

bad="$(git log --format='%h%x09%an <%ae>%x09%cn <%ce>' "$@" | awk -F '\t' -v id="$ID" '$2 != id || $3 != id')"
[ -z "$bad" ] || fail "these commits use another identity (hash, author, committer):
$bad"
