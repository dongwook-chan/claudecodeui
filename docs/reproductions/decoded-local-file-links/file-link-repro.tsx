import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
const baseline = new URLSearchParams(location.search).has('baseline');
const { Markdown } = baseline ? await import('./file-link-baseline') : await import('@/modules/chat/transcript/Markdown');
const expected = '/workspace/자료/경력-원장.md';
const markdown = `[경력 원장 열기](${expected})`;
function Repro() {
  const [opened, setOpened] = useState('');
  usePaletteOpsRegister({ openFileInEditor: (path) => setOpened(path) });
  return <main style={{ maxWidth: 1040, margin: '54px auto', fontFamily: 'system-ui, sans-serif', lineHeight: 1.7, color: '#182438' }}>
    <h1>CloudCLI · Korean file link</h1>
    <p><strong>{baseline ? 'Before · unmodified upstream main (13e9ef64)' : 'After · local href decoded once'}</strong></p>
    <p>The real Markdown renderer and palette callback are used. No backend, auth, or installation patches are involved.</p>
    <section style={{ padding: 24, border: '1px solid #cbd5e1', borderRadius: 12, marginTop: 24 }}>
      <h2>Chat Markdown</h2><pre style={{ background: '#f1f5f9', padding: 16 }}>{markdown}</pre>
      <div style={{ fontSize: 22 }}><Markdown>{markdown}</Markdown></div>
    </section>
    <section style={{ padding: 24, border: '1px solid #cbd5e1', borderRadius: 12, marginTop: 24 }}>
      <h2>Editor callback</h2><p>Expected filesystem path:</p><code>{expected}</code>
      <p>Actual path passed to the editor:</p><pre data-testid="actual" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: '#f1f5f9', padding: 16 }}>{opened || 'Click the link above'}</pre>
      {opened && <p data-testid="result" style={{ color: opened === expected ? '#087443' : '#b42318', fontSize: 22, fontWeight: 700 }}>{opened === expected ? 'PASS · the editor receives the intended filesystem path' : 'FAIL · the editor receives percent escapes as filename characters'}</p>}
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<PaletteOpsProvider><Repro /></PaletteOpsProvider>);
