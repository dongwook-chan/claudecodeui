# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## CloudCLI release patches

Before updating or deploying a CloudCLI release candidate, read `/home/ubuntu/cloudcli-maintenance/patches/README.md` and `manifest.json`. Resolve `reviewItems`, apply active patches with `prepare-release.mjs`, and run the listed tests; a passing manifest check alone is insufficient.
