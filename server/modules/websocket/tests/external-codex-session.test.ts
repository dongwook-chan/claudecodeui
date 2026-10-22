import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection extends EventEmitter {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(data: string): void { this.frames.push(JSON.parse(data)); }
}

test('external Codex ownership survives subscribe, rejects duplicate sends and supports Stop', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'external-codex-chat-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalActivity = sessionsService.getExternalSessionActivity;
  const originalAbort = sessionsService.abortExternalSession;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession('external-app', 'codex', directory);
    let external = true;
    let stopSucceeds = false;
    let started = 0;
    sessionsService.getExternalSessionActivity = async (sessionId) => external ? {
      sessionId, provider: 'codex', startedAt: 1, lastSeq: 0,
      canInterrupt: true, external: true, statusText: 'Running in the Codex CLI',
    } : null;
    sessionsService.abortExternalSession = async () => {
      if (stopSucceeds) external = false;
      return stopSucceeds;
    };

    // A completed local run must not replay its terminal event over the new
    // external writer's subscribe acknowledgement.
    chatRunRegistry.startRun({ appSessionId: 'external-app', provider: 'codex', providerSessionId: null, connection: null, userId: null });
    chatRunRegistry.completeRun('external-app', { exitCode: 0 });
    const connection = new FakeConnection();
    handleChatConnection(connection as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async () => { started += 1; },
        abort: async () => { throw new Error('External Stop must use the native owner.'); },
        stopBackgroundTask: async () => false,
        hasBackgroundWork: () => false,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
    });
    const dispatch = async (frame: Record<string, unknown>) => {
      connection.emit('message', Buffer.from(JSON.stringify(frame)));
      await new Promise((resolve) => setImmediate(resolve));
    };
    await dispatch({ type: 'chat.subscribe', sessions: [{ sessionId: 'external-app', lastSeq: 0 }] });
    assert.equal(connection.frames[0]?.kind, 'chat_subscribed');
    assert.equal(connection.frames[0]?.isProcessing, true);
    assert.equal(connection.frames[0]?.canInterrupt, true);
    assert.equal(connection.frames.length, 1);

    const clientSendId = '5e7df7e5-3a61-47c3-a604-b8b9e52c5852';
    await dispatch({ type: 'chat.send', sessionId: 'external-app', content: 'follow-up', clientSendId });
    assert.equal(started, 0);
    assert.equal(connection.frames.at(-1)?.code, 'RUN_IN_PROGRESS');
    assert.equal(sessionsDb.wasClientSendAccepted('external-app', clientSendId), false);

    await dispatch({ type: 'chat.abort', sessionId: 'external-app' });
    assert.equal(connection.frames.at(-1)?.code, 'ABORT_FAILED');
    assert.equal(external, true);

    stopSucceeds = true;
    await dispatch({ type: 'chat.abort', sessionId: 'external-app' });
    assert.equal(connection.frames.at(-1)?.kind, 'complete');
    assert.equal(connection.frames.at(-1)?.aborted, true);
    assert.equal(external, false);

    await dispatch({ type: 'chat.send', sessionId: 'external-app', content: 'follow-up', clientSendId });
    assert.equal(started, 1);
    assert.equal(sessionsDb.wasClientSendAccepted('external-app', clientSendId), true);
  } finally {
    sessionsService.getExternalSessionActivity = originalActivity;
    sessionsService.abortExternalSession = originalAbort;
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('external Antigravity activity survives subscribe and rejects a second prompt without a receipt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'external-antigravity-chat-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalActivity = sessionsService.getExternalSessionActivity;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession('external-agy-app', 'antigravity', directory);
    sessionsService.getExternalSessionActivity = async (sessionId) => ({
      sessionId, provider: 'antigravity', startedAt: 1, lastSeq: 0,
      canInterrupt: false, external: true, statusText: 'Running in the Antigravity CLI',
    });
    let started = false;
    const connection = new FakeConnection();
    handleChatConnection(connection as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async () => { started = true; },
        abort: async () => { throw new Error('Do not signal an interactive AGY process.'); },
        stopBackgroundTask: async () => false,
        hasBackgroundWork: () => false,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
    });
    connection.emit('message', Buffer.from(JSON.stringify({
      type: 'chat.subscribe', sessions: [{ sessionId: 'external-agy-app', lastSeq: 0 }],
    })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection.frames[0]?.isProcessing, true);
    assert.equal(connection.frames[0]?.canInterrupt, false);
    assert.equal(connection.frames[0]?.statusText, 'Running in the Antigravity CLI');

    const clientSendId = '6e7df7e5-3a61-47c3-a604-b8b9e52c5852';
    connection.emit('message', Buffer.from(JSON.stringify({
      type: 'chat.send', sessionId: 'external-agy-app', content: 'follow-up', clientSendId,
    })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, false);
    assert.equal(connection.frames.at(-1)?.code, 'RUN_IN_PROGRESS');
    assert.match(String(connection.frames.at(-1)?.error), /Antigravity/);
    assert.equal(sessionsDb.wasClientSendAccepted('external-agy-app', clientSendId), false);
  } finally {
    sessionsService.getExternalSessionActivity = originalActivity;
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
