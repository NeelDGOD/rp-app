#!/usr/bin/env bash
# Bundles tests/js/branches.test.js (+ frontend/src/lib/branches.js + fixtures.json) with esbuild and runs it with node:test.
set -e
cd "$(dirname "$0")"
npx --yes esbuild@0.24.0 branches.test.js --bundle --platform=node --format=cjs --log-level=warning --outfile=.build/branches.test.cjs
node --test .build/branches.test.cjs
