#!/usr/bin/env bash
# Run the suite. Only *.test.mjs are tests; helpers/ holds the fake `gh` shim.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
exec node --test "scripts/test/"*.test.mjs
