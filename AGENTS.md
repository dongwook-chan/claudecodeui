# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## CloudCLI release patches

Before updating or deploying a CloudCLI release candidate, read `/home/ubuntu/cloudcli-maintenance/patches/README.md` and `manifest.json`. Resolve `reviewItems`, apply active patches with `prepare-release.mjs`, and run the listed tests; a passing manifest check alone is insufficient.

## CloudCLI release workspace cleanup

- Before creating a candidate, inventory existing candidates for the target release and inspect their branch, patch state, uncommitted changes, and active users. Continue a compatible existing candidate when safe. Create another only for a concrete isolation need, such as a different patch set or an independent comparison, and record why; do not blindly rerun preparation after a conflict or interruption.
- Install dependencies only in candidates that need testing or building. Avoid retaining separate `node_modules` trees for abandoned attempts and completed comparisons.
- After deployment status reports success, verify health, the required browser check, and interrupted-session continuation before treating deployment work as complete. Then inspect and clean obsolete candidate worktrees and temporary patch-source worktrees, including their dependencies and build outputs. Report what was removed, what was retained and why, and disk space reclaimed. If cleanup cannot be completed, report the remaining work explicitly.
- Before removal, verify that no active process, session, deployment, symlink, or recovery path depends on the workspace. Protect the running release, the last-successful release, and the previous known-good release needed for rollback. Never stop the service or remove live dependencies to reclaim space.
- Preserve uncommitted or untracked work and ensure unique commits, required patch-source commits, and manifest references remain reachable through retained Git refs before removing a worktree. Do not force-remove a dirty worktree or abort an in-progress cherry-pick merely for cleanup. Use Git worktree removal for registered worktrees rather than deleting their directories directly.
- Keep failed or interrupted attempts only while they support active investigation or recovery, with a recorded reason. Revisit them on the next release task. These instructions require agent cleanup; they do not imply that the preparation or deployment scripts already enforce automatic retention limits.
