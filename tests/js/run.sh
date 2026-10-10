#!/usr/bin/env bash
# Bundles every tests/js/*.test.js (+ the frontend lib modules they import + fixtures.json) with esbuild and runs them with node:test.
set -e
cd "$(dirname "$0")"
for t in branches chain; do
  npx --yes esbuild@0.24.0 "$t.test.js" --bundle --platform=node --format=cjs --log-level=warning --outfile=".build/$t.test.cjs"
done
node --test .build/branches.test.cjs .build/chain.test.cjs
