# Reproducing local Markdown file-link decoding

The screenshots use synthetic paths and the real CloudCLI `Markdown` renderer
and palette registry. The small harness displays the exact path delivered to
`openFileInEditor`; it does not mock the Markdown parser. It isolates the bug
from backend file access, authentication and installation-specific patches.

Upstream base: `13e9ef64977d909eaf881eb83fec250c679f3d5c` (v1.37.7/main).
Input: `[경력 원장 열기](/workspace/자료/경력-원장.md)`.

Before: `/workspace/%EC%9E%90%EB%A3%8C/%EA%B2%BD%EB%A0%A5-%EC%9B%90%EC%9E%A5.md`.
After: `/workspace/자료/경력-원장.md`.

## Run the screenshot harness

From the repository root on this evidence branch (it contains the PR fix):

```bash
npm ci --include=dev
cp docs/reproductions/decoded-local-file-links/file-link-repro.html .
cp docs/reproductions/decoded-local-file-links/file-link-repro.tsx .
git show 13e9ef64977d909eaf881eb83fec250c679f3d5c:src/modules/chat/transcript/Markdown.tsx > file-link-baseline.tsx
npm run client -- --host 127.0.0.1 --port 5187
```

Open `http://127.0.0.1:5187/file-link-repro.html?baseline=1` and click the Korean
link. The callback receives the percent-encoded path. Open the same page
without the query string and click again: the callback receives the Unicode
filesystem path. This harness sends no messages and requires no account.

After stopping the dev server, remove the three root-level fixture copies:
`file-link-repro.html`, `file-link-repro.tsx` and `file-link-baseline.tsx`.

The PR's regression file exercises the same real parser under Vitest and also
covers Chinese, Japanese, accented names, encoded spaces, literal percent
signs, one-pass decoding, directories, line suffixes and external URLs.
