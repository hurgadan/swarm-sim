#!/usr/bin/env bash
# Stop hook: when api source has uncommitted changes, run lint + unit tests and
# block completion until they pass. Makes "code written -> verified" impossible
# to skip. Skips entirely when api/src is clean (e.g. pure-conversation turns).
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
cd "$root" || exit 0

# Only act if api/src has uncommitted (staged or unstaged) changes.
if ! git status --porcelain -- api/src 2>/dev/null | grep -q .; then
  exit 0
fi

cd api || exit 0

if ! lint_out="$(npm run -s lint 2>&1)"; then
  echo "Stop blocked — eslint is failing. Fix before finishing:" >&2
  echo "$lint_out" >&2
  exit 2
fi

if ! test_out="$(npm run -s test:unit 2>&1)"; then
  echo "Stop blocked — unit tests are failing. Fix before finishing:" >&2
  echo "$test_out" >&2
  exit 2
fi

exit 0
