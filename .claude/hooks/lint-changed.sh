#!/usr/bin/env bash
# PostToolUse hook: lint a single TypeScript file right after Claude edits it.
# Fast, deterministic gate on generated code. Exit 2 feeds eslint output back
# to the model so it can fix the issue before moving on.
set -uo pipefail

input="$(cat)"

# Extract the edited file path from the tool event JSON.
file="$(printf '%s' "$input" | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" \
  2>/dev/null || true)"

[ -z "$file" ] && exit 0

# Only lint api TypeScript sources.
case "$file" in
  */api/*.ts) ;;
  *) exit 0 ;;
esac

root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
cd "$root/api" 2>/dev/null || exit 0

out="$(npx --no-install eslint "$file" 2>&1)"
if [ $? -ne 0 ]; then
  echo "ESLint failed for $file:" >&2
  echo "$out" >&2
  exit 2
fi
exit 0
