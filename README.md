# Inline math rendering evidence

Source commit: b7db9a8085bbcb53fa3e29a1aac13abc55fc84cb
Base: a8c78139 (upstream main, 2026-11-09).

The image compares the previous remark-math configuration with the actual updated chat MarkdownBody renderer using a focused HTML harness in headless Chromium. It demonstrates the Korean attention example, currency values, and literal code.

Validation: 154 frontend test files / 1,149 tests passed; typecheck passed; lint passed with existing warnings; client and server production build passed. Focused tests reran after type-only corrections (22 passed).

Single-dollar math rejects leading/trailing inner whitespace, line breaks, and a closing delimiter immediately followed by a digit.
