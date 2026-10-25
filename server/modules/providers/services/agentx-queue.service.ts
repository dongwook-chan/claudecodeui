import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { AgentxQueuedSession } from '@/shared/index.js';

type QueueServiceOptions = { getSocketPath?: () => string; timeoutMs?: number };

/** Providers uses this local IPC adapter for queue status/cancellation; tests supply an isolated socket. */
export function createAgentxQueueService(options: QueueServiceOptions = {}) {
  const getSocketPath = options.getSocketPath ?? (() => process.env.AGENTX_SUPERVISOR_SOCKET
    || path.join(process.env.AGENTX_SUPERVISOR_DIR || path.join(os.homedir(), '.config', 'agentx'), 'run', 'supervisor.sock'));

  async function request(value: Record<string, string>): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const socket = createConnection(getSocketPath());
      let input = '';
      let settled = false;
      const finish = (result: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setEncoding('utf8');
      socket.setTimeout(options.timeoutMs ?? 750, () => finish(null));
      socket.on('error', () => finish(null));
      socket.on('end', () => finish(null));
      socket.on('connect', () => socket.write(`${JSON.stringify(value)}\n`));
      socket.on('data', (chunk: string) => {
        input += chunk;
        if (input.length > 1024 * 1024) return finish(null);
        if (!input.includes('\n')) return;
        try {
          const parsed: unknown = JSON.parse(input.slice(0, input.indexOf('\n')));
          finish(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null);
        } catch { finish(null); }
      });
    });
  }

  async function listSessions(): Promise<AgentxQueuedSession[]> {
    const reply = await request({ command: 'rate-limit-status' });
    if (!reply?.ok || !Array.isArray(reply.records)) return [];
    return reply.records.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (record.status !== 'queued' || typeof record.sessionId !== 'string' || !record.sessionId
        || typeof record.queuedAt !== 'number' || !Number.isFinite(record.queuedAt)
        || typeof record.nextRetryAt !== 'number' || !Number.isFinite(record.nextRetryAt)
        || !Number.isSafeInteger(record.queuePosition) || Number(record.queuePosition) < 1
        || !Number.isSafeInteger(record.attempts) || Number(record.attempts) < 0) return [];
      return [{ sessionId: record.sessionId, queuedAt: record.queuedAt, nextRetryAt: record.nextRetryAt,
        queuePosition: Number(record.queuePosition), attempts: Number(record.attempts) }];
    });
  }

  return {
    listSessions,
    async getSession(sessionId: string) { return (await listSessions()).find((entry) => entry.sessionId === sessionId) ?? null; },
    async cancelSession(sessionId: string): Promise<boolean> {
      const reply = await request({ command: 'rate-limit-cancel', sessionId });
      return reply?.ok === true && reply.cancelled === true;
    },
  };
}

/** Sessions service reports AgentX waiting work and cancels it without signaling any native process. */
export const agentxQueueService = createAgentxQueueService();
