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
  send(): void {}
}

test('running-session recovery preserves the exact launch permissions across sends and reconnects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chat-resume-options-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalActivity = sessionsService.getExternalSessionActivity;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  sessionsService.getExternalSessionActivity = async () => null;
  try {
    sessionsDb.createAppSession('resume-app', 'codex', directory);
    const connection = new FakeConnection();
    let finish: () => void = () => {};
    let runtimeOptions: Record<string, any> = {};
    handleChatConnection(connection as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider, _command, options) => {
          runtimeOptions = options;
          await new Promise<void>((resolve) => { finish = resolve; });
        },
        abort: async () => false,
        stopBackgroundTask: async () => false,
        hasBackgroundWork: () => false,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
    });
    for (const permissionMode of ['bypassPermissions', 'acceptEdits', 'default', 'plan', undefined]) {
      const options = {
        ...(permissionMode ? { permissionMode } : {}),
        skipPermissions: false,
        toolsSettings: { allowedTools: ['Read'], disallowedTools: ['Bash'], allowedShellCommands: [], skipPermissions: false, secret: 'not-recoverable' },
        model: 'gpt-6.1-sol', effort: 'high',
        images: [], apiKey: 'not-recoverable', resumeAtMessageId: 'never-repeat-edit',
      };
      connection.emit('message', Buffer.from(JSON.stringify({ type: 'chat.send', sessionId: 'resume-app', content: 'hello', options })));
      await new Promise((resolve) => setImmediate(resolve));
      const expected = {
        ...(permissionMode ? { permissionMode } : {}),
        model: 'gpt-6.1-sol', effort: 'high', cwd: directory, projectPath: directory,
        skipPermissions: false,
        toolsSettings: { allowedTools: ['Read'], disallowedTools: ['Bash'], allowedShellCommands: [], skipPermissions: false },
      };
      const entry = chatRunRegistry.listRunningRuns().find((item) => item.sessionId === 'resume-app');
      assert.deepEqual(entry?.resumeOptions, expected);
      assert.equal(runtimeOptions.permissionMode, permissionMode);

      // Neither runtime mutation nor a caller changing the API result may
      // rewrite the original permission snapshot.
      runtimeOptions.toolsSettings.allowedTools.push('Write');
      entry!.resumeOptions!.toolsSettings!.allowedTools!.push('Edit');
      chatRunRegistry.attachConnection('resume-app', new FakeConnection());
      assert.deepEqual(chatRunRegistry.listRunningRuns()[0]?.resumeOptions, expected);
      assert.deepEqual((await sessionsService.listRunningSessions()).find((item) => item.sessionId === 'resume-app')?.resumeOptions, expected);

      finish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(chatRunRegistry.isProcessing('resume-app'), false);
    }
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
