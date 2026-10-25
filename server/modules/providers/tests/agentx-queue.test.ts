import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentxQueueService } from '@/modules/providers/services/agentx-queue.service.js';

test('local IPC exposes only validated waiting records and cancels the requested native session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-agentx-'));
  const socketPath = path.join(root, 'supervisor.sock');
  const requests: Record<string, unknown>[] = [];
  const queued = { sessionId: 'native-id', status: 'queued', queuedAt: 100, nextRetryAt: 200, queuePosition: 2, attempts: 1 };
  const server = createServer((socket) => socket.on('data', (data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    socket.end(JSON.stringify(request.command === 'rate-limit-status'
      ? { ok: true, records: [{ ...queued, prompt: 'private' }, { ...queued, status: 'running' }, { sessionId: 'invalid', status: 'queued' }] }
      : { ok: true, cancelled: request.sessionId === 'native-id' }) + '\n');
  }));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const service = createAgentxQueueService({ getSocketPath: () => socketPath });
    const { status: _status, ...expected } = queued;
    assert.deepEqual(await service.listSessions(), [expected]);
    assert.equal(await service.getSession('missing'), null);
    assert.equal(await service.cancelSession('native-id'), true);
    assert.deepEqual(requests.at(-1), { command: 'rate-limit-cancel', sessionId: 'native-id' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('missing or unsupported AgentX is optional and does not block the normal running-session poll', async () => {
  const service = createAgentxQueueService({ getSocketPath: () => '/tmp/cloudcli-no-agentx-socket' });
  assert.deepEqual(await service.listSessions(), []);
  assert.equal(await service.cancelSession('native-id'), false);
});
