#!/usr/bin/env bash
set -euo pipefail

# Bump version of a package based on commit message semantics.
# feat: or merge from feat/* → minor bump (patch resets to 0)
# anything else              → patch bump
#
# Usage: .github/scripts/bump-version.sh <path/to/package.json>

PACKAGE_JSON_PATH="${1:?Usage: bump-version.sh <path/to/package.json>}"

if [[ ! -f "$PACKAGE_JSON_PATH" ]]; then
  echo "package.json not found: $PACKAGE_JSON_PATH"
  exit 1
fi

current_version=$(node -p "require('./$PACKAGE_JSON_PATH').version")
IFS='.' read -r major minor patch <<< "$current_version"

commit_msg=$(git log -1 --pretty=%B | tr '\n' ' ')

if echo "$commit_msg" | grep -qEi 'feat:|from .*/feat/'; then
  minor=$((minor + 1))
  patch=0
else
  patch=$((patch + 1))
fi

new_version="$major.$minor.$patch"

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON_PATH', 'utf8'));
pkg.version = '$new_version';
fs.writeFileSync('$PACKAGE_JSON_PATH', JSON.stringify(pkg, null, 2) + '\n');
"

echo "version=$new_version" >> "$GITHUB_OUTPUT"
echo "Bumped $PACKAGE_JSON_PATH: $current_version → $new_version"
