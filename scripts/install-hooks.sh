#!/bin/sh
# Point git at the repo's tracked hooks. Run once after cloning:
#   sh scripts/install-hooks.sh
# (Hooks in .git/hooks/ are not shared; .githooks/ is tracked and travels with the repo.)
set -e
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "✓ git hooks installed (core.hooksPath = .githooks)"
echo "  pre-commit now runs 'npm run lint:boundaries' before each commit."
