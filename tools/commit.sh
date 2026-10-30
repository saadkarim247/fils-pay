#!/usr/bin/env bash
# commit.sh "<message>" <paths...>
# Commits exactly these paths on top of HEAD, keeping the executable bit on
# any *.sh. Needed on Windows: a plain `git commit -m ... -- <paths>` takes the
# file mode from the working tree (always 644). Uses a temporary index, so
# anything else you have staged stays staged and out of this commit.
# For files that are not shell scripts, `git commit -m "..." -- <paths>` is enough.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
[ $# -ge 2 ] || { echo 'usage: tools/commit.sh "<message>" <paths...>' >&2; exit 2; }
MSG=$1; shift
BRANCH=$(git symbolic-ref -q HEAD) || { echo "detached HEAD: check out a branch first" >&2; exit 1; }
GITDIR=$(git rev-parse --git-dir)
export GIT_INDEX_FILE="$GITDIR/tmp-commit-index"
trap 'rm -f "$GITDIR/tmp-commit-index"' EXIT
git read-tree HEAD
git add -- "$@"
for f in "$@"; do case $f in *.sh) [ -f "$f" ] && git update-index --chmod=+x -- "$f";; esac; done
T=$(git write-tree); C=$(git commit-tree "$T" -p HEAD -m "$MSG")
git update-ref "$BRANCH" "$C"
unset GIT_INDEX_FILE
# Sync the real index for these paths only (and keep their +x there too).
git reset -q -- "$@" 2>/dev/null || true
for f in "$@"; do case $f in *.sh) [ -f "$f" ] && git update-index --chmod=+x -- "$f";; esac; done
git --no-pager log --oneline -1 --stat
