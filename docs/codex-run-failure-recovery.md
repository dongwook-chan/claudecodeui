# Codex runs that end without a reply

On 2026-11-07, the onlyfans conversation's 01:42 UTC prompt was retained in its
native rollout, but no assistant message or task completion followed. Local
wire telemetry recorded the response connection ending 152 ms after that prompt
request began, without a response ID or an upstream error payload. The worker
was no longer running. This evidence does not establish who closed the
connection or the original transport/process fault. The two other recent
conversations had normal final answers.

Two separate CloudCLI defects were reproducible: the runtime treated an SDK
`AbortError` or any exception containing "aborted" as user cancellation, and
an exhausted SDK stream was treated as success even without `turn.completed`
or an assistant message. Completed run events are not replayed on reconnect,
and native rollouts do not reliably retain transport failures. A lost live
failure could therefore leave the conversation showing only its last question.

The runtime now requires its own cancellation state/signal before suppressing
an error. An incomplete stream, empty completed reply, fatal event or SDK
exception produces a failed completion. Nonfatal item errors may still recover
successfully. There is no automatic resend: tools may already have performed
side effects even when the final reply is missing.

A failure receives one stable ID and a durable notice in the app database.
Session history merges notices after the native-file cache and before
pagination, including failed launches without a native session ID. Diagnostics
record app/native IDs, model/effort, event count and last event type, completion
and reply observations, and available SDK exit/signal and known transport-code
metadata. They never store the prompt, generated/tool output or raw stderr;
missing exit information remains null rather than implying a normal exit.
Diagnostics stay server-side. The journal is capped at 100 failures per session,
prunes entries older than 90 days on writes, and cascades on session deletion.

Regression evidence on the original runtime: 11 failures out of 13 targeted
checks. The fixed checks cover transport errors, silent exits, normal replies,
real user Stop, fatal versus nonfatal events, duplicate terminal reports,
journal write failure, and actual SDK subprocess exit-zero/exit-error/SIGTERM
fixtures without inference requests. History coverage checks database reopen,
a pre-existing transcript cache, pagination, missing native transcripts,
idempotence, retention and deletion.

The 2026-11-07 prepared v1.37.7 candidate passed 27 focused checks; all registered
backend regressions (319 passed, one optional check skipped); 220 frontend
checks across 32 files; typecheck, lint and build. Existing lint warnings remain.
One pre-existing edit/send test was stabilized to wait for its actual refusal
before closing its database instead of assuming a 30 ms delay was sufficient.

An isolated real Chromium/CloudCLI fixture confirmed a visible live failure,
reload persistence, recovery after closing the page during a failing run, and
exactly one notice per failed attempt. This fixture used no inference requests;
its server and private test data were removed. Per-attempt evidence and the
screenshot are retained under
`~/.local/state/cloudcli-deploy/codex-run-failure-20261107/` for review by
2027-02-05 or the next related incident, whichever comes first.

This fixes silent failure handling and improves future diagnosis. It does not
claim to prevent every network disconnection or establish the original fault.
