import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexCliLivenessService } from '@/modules/providers/services/codex-cli-liveness.service.js';

const THREAD_ID = '01a14f63-d1ad-7731-b7c5-a11e0cef265e';
const PID = 12345;

async function withWriter(
  run: (fixture: { directory: string; procRoot: string; codexHome: string; lockLine: string }) => Promise<void>,
  args = ['codex', '--dangerously-bypass-approvals-and-sandbox', 'exec', 'resume', '--all', THREAD_ID, 'continue'],
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-liveness-'));
  const procRoot = path.join(directory, 'proc');
  const codexHome = path.join(directory, 'codex');
  try {
    await mkdir(path.join(codexHome, 'thread-writer-locks'), { recursive: true });
    await mkdir(path.join(procRoot, String(PID)), { recursive: true });
    const lockPath = path.join(codexHome, 'thread-writer-locks', `${THREAD_ID}.lock`);
    await writeFile(lockPath, '');
    const lockStat = await stat(lockPath, { bigint: true });
    const major = ((lockStat.dev >> 8n) & 0xfffn) | ((lockStat.dev >> 32n) & 0xfffff000n);
    const minor = (lockStat.dev & 0xffn) | ((lockStat.dev >> 12n) & 0xffffff00n);
    const lockLine = `1: FLOCK ADVISORY WRITE ${PID} ${major.toString(16)}:${minor.toString(16)}:${lockStat.ino} 0 EOF\n`;
    await writeFile(path.join(procRoot, 'locks'), lockLine);
    await symlink('/opt/codex/bin/codex', path.join(procRoot, String(PID), 'exe'));
    // starttime is field 22, counted after a comm containing spaces and ')'.
    await writeFile(path.join(procRoot, String(PID), 'stat'), `${PID} (codex worker)) S ${Array(18).fill('0').join(' ')} 789 0\n`);
    await writeFile(path.join(procRoot, String(PID), 'cmdline'), `${args.join('\0')}\0`);
    await run({ directory, procRoot, codexHome, lockLine });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a held native writer lock reports the dedicated Codex exec process', async () => {
  await withWriter(async ({ procRoot, codexHome }) => {
    const service = createCodexCliLivenessService({ procRoot, getCodexHome: () => codexHome, getRolloutPath: () => null });
    const sessions = await service.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].providerSessionId, THREAD_ID);
    assert.equal(sessions[0].pid, PID);
    assert.equal(sessions[0].procStart, '789');
    assert.equal(sessions[0].canInterrupt, true);
    assert.equal(sessions[0].isProcessing, true);
    assert.ok(sessions[0].startedAt > 0);
  });
});

test('a dedicated exec remains processing until it releases ownership, even after persisting completion', async () => {
  await withWriter(async ({ directory, procRoot, codexHome }) => {
    const rollout = path.join(directory, 'rollout.jsonl');
    await writeFile(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
    const service = createCodexCliLivenessService({ procRoot, getCodexHome: () => codexHome, getRolloutPath: () => rollout });
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, true);
    await writeFile(path.join(procRoot, 'locks'), '');
    assert.equal(await service.getSession(THREAD_ID), null);
  });
});

test('stale files, waiting locks and unrelated inodes do not make a session busy', async () => {
  await withWriter(async ({ procRoot, codexHome, lockLine }) => {
    const service = createCodexCliLivenessService({ procRoot, getCodexHome: () => codexHome });
    for (const locks of ['', lockLine.replace('FLOCK', '-> FLOCK'), lockLine.replace(/:\d+ 0 EOF/, ':99999999999 0 EOF')]) {
      await writeFile(path.join(procRoot, 'locks'), locks);
      assert.deepEqual(await service.listSessions(), []);
    }
  });
});

test('a vanished owner is ignored and app-server writers are never interruptible', async () => {
  await withWriter(async ({ procRoot, codexHome }) => {
    const service = createCodexCliLivenessService({ procRoot, getCodexHome: () => codexHome, getRolloutPath: () => null });
    assert.equal((await service.getSession(THREAD_ID))?.canInterrupt, false);
    assert.equal(await service.abortSession(THREAD_ID), false);
    await rm(path.join(procRoot, String(PID)), { recursive: true });
    assert.deepEqual(await service.listSessions(), []);
  }, ['codex', 'app-server']);
});

test('stop signals only the lock owner and succeeds after its writer lock is released', async () => {
  await withWriter(async ({ procRoot, codexHome }) => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const service = createCodexCliLivenessService({
      procRoot,
      getCodexHome: () => codexHome,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        // Simulate the native process exiting synchronously after SIGINT.
        service.getSession = async () => null;
      },
    });
    assert.equal(await service.abortSession(THREAD_ID), true);
    assert.deepEqual(signals, [[PID, 'SIGINT']]);
  });
});

test('a PID with a different process start time is never signaled', async () => {
  const signals: number[] = [];
  const service = createCodexCliLivenessService({ signal: (pid) => { signals.push(pid); } });
  let checks = 0;
  service.getSession = async () => ({ providerSessionId: THREAD_ID, pid: PID, procStart: String(checks++), startedAt: 1, canInterrupt: true, isProcessing: true });
  assert.equal(await service.abortSession(THREAD_ID), false);
  assert.deepEqual(signals, []);
});

test('a completed ping/pong turn retains ownership without reporting a persistent app-server as processing', async () => {
  await withWriter(async ({ directory, procRoot, codexHome }) => {
    const rollout = path.join(directory, 'rollout.jsonl');
    await writeFile(rollout, [
      { type: 'event_msg', timestamp: '2026-10-25T16:09:36.215Z', payload: { type: 'task_started', turn_id: 'ping' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] } },
      { type: 'event_msg', timestamp: '2026-10-25T16:09:38.148Z', payload: { type: 'task_complete', turn_id: 'ping', last_agent_message: 'pong' } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const service = createCodexCliLivenessService({ procRoot, getCodexHome: () => codexHome, getRolloutPath: () => rollout });
    const owner = await service.getSession(THREAD_ID);
    assert.equal(owner?.isProcessing, false);
    assert.equal(owner?.pid, PID, 'an idle session still has a verified exclusive writer');
    assert.equal(owner?.canInterrupt, false);
    assert.equal(await service.abortSession(THREAD_ID), false);

    const startedAt = '2026-10-25T17:00:00.000Z';
    await appendFile(rollout, JSON.stringify({ type: 'event_msg', timestamp: startedAt, payload: { type: 'task_started', turn_id: 'resume' } }) + '\n');
    const resumed = await service.getSession(THREAD_ID);
    assert.equal(resumed?.isProcessing, true, 'a new turn overrides the previous completion without restarting the owner');
    assert.equal(resumed?.startedAt, Date.parse(startedAt));
    await appendFile(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'resume' } }) + '\n');
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, false);
    await writeFile(path.join(procRoot, 'locks'), '');
    assert.equal(await service.getSession(THREAD_ID), null, 'a transcript alone is not a live writer');
  }, ['codex', 'app-server']);
});

test('persistent TUI activity reads bounded tails and remains conservative for incomplete or unavailable rollouts', async () => {
  await withWriter(async ({ directory, procRoot, codexHome }) => {
    const rollout = path.join(directory, 'rollout.jsonl');
    const service = createCodexCliLivenessService({ procRoot, getCodexHome: () => codexHome, getRolloutPath: () => rollout });
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, true, 'missing transcript is unknown, not proven idle');
    const complete = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n';
    const hugeResult = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300_000) } }) + '\n';
    await writeFile(rollout, hugeResult + complete);
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, false, 'a large tool result before completion does not hide completion');
    await appendFile(rollout, '{"type":"event_msg","payload":');
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, true, 'a partly written new event must not expose an older idle boundary');
    await writeFile(rollout, complete + hugeResult);
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, true, 'no boundary within the bounded tail remains unknown');
    await writeFile(rollout, complete + JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'task_started' } }) + '\n');
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, false, 'message text is not a lifecycle event');
    await writeFile(rollout, 'null\n[]\n');
    assert.equal((await service.getSession(THREAD_ID))?.isProcessing, true);
  }, ['codex']);
});

test('another executable holding a similarly named lock is ignored', async () => {
  await withWriter(async ({ procRoot, codexHome }) => {
    await rm(path.join(procRoot, String(PID), 'exe'));
    await symlink('/usr/bin/node', path.join(procRoot, String(PID), 'exe'));
    const service = createCodexCliLivenessService({ procRoot, getCodexHome: () => codexHome });
    assert.deepEqual(await service.listSessions(), []);
  });
});
