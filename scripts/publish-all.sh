#!/usr/bin/env bash
# Publish only packages whose version is not yet on the registry.
set -uo pipefail
for p in core security storage providers runtime term input config session knowledge ctx tools agents workflows ext repl server github-bot qofeno-cli; do
  dir="packages/$p"
  [ -f "$dir/package.json" ] || continue
  name=$(node -p "require('./$dir/package.json').name")
  version=$(node -p "require('./$dir/package.json').version")
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "skip $name@$version (already published)"
    continue
  fi
  npm publish "./$dir" --access public --provenance
done
