import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { getLinuxFileLockIdentity, parseLinuxExclusiveFileLocks } from '@/shared/index.js';

type CodexCliSession = {
  providerSessionId: string;
  pid: number;
  procStart: string;
  startedAt: number;
  canInterrupt: boolean;
  /** False only when a persistent owner's latest turn is proven complete. */
  isProcessing: boolean;
};

type LivenessOptions = {
  procRoot?: string;
  getCodexHome?: () => string;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  getRolloutPath?: (providerSessionId: string) => string | null;
};

const THREAD_LOCK_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
const MAX_LOCK_FILES = 4096;
const MAX_ROLLOUT_TAIL_BYTES = 256 * 1024;

/** A retained writer proves ownership, but only the latest turn boundary proves activity. */
async function readTurnActivity(rolloutPath: string | null): Promise<{ isProcessing: boolean; startedAt?: number }> {
  if (!rolloutPath) return { isProcessing: true };
  let file: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    file = await fsp.open(rolloutPath, 'r');
    const { size } = await file.stat();
    const offset = Math.max(0, size - MAX_ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_ROLLOUT_TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let tail = buffer.subarray(0, bytesRead).toString('utf8');
    // A bounded read may begin inside a very large tool result. Its partial
    // first row is never parsed as an event. Unknown/truncated data stays busy.
    if (offset > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    const lines = tail.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { return { isProcessing: true }; }
      if (event?.type !== 'event_msg') continue;
      if (event.payload?.type === 'task_started') {
        const startedAt = Date.parse(event.timestamp);
        return { isProcessing: true, ...(Number.isFinite(startedAt) ? { startedAt } : {}) };
      }
      if (['task_complete', 'turn_aborted'].includes(event.payload?.type)) return { isProcessing: false };
    }
  } catch {
    // An unreadable or not-yet-indexed rollout must not weaken writer protection.
  } finally {
    await file?.close();
  }
  return { isProcessing: true };
}

/** Providers uses this factory to distinguish native writer ownership from turn activity; tests isolate procfs and rollouts. */
export function createCodexCliLivenessService(options: LivenessOptions = {}) {
  const procRoot = options.procRoot ?? '/proc';
  const getCodexHome = options.getCodexHome
    ?? (() => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const signal = options.signal ?? ((pid: number, value: NodeJS.Signals) => { process.kill(pid, value); });
  const getRolloutPath = options.getRolloutPath
    ?? ((providerSessionId: string) => sessionsDb.getSessionByProviderSessionId(providerSessionId)?.jsonl_path ?? null);

  async function listSessions(): Promise<CodexCliSession[]> {
    if (process.platform !== 'linux') return [];

    const directory = path.join(getCodexHome(), 'thread-writer-locks');
    let locks: string;
    let names: string[];
    try {
      [locks, names] = await Promise.all([
        fsp.readFile(path.join(procRoot, 'locks'), 'utf8'),
        fsp.readdir(directory),
      ]);
    } catch (error) {
      // Missing procfs or a Codex home without writer locks is normal. Other
      // failures must not silently authorize a second writer.
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
      throw error;
    }

    const holders = parseLinuxExclusiveFileLocks(locks);

    const sessions: CodexCliSession[] = [];
    const lockNames = names.filter((name) => THREAD_LOCK_NAME.test(name));
    if (lockNames.length > MAX_LOCK_FILES) throw new Error('Too many Codex writer locks to inspect safely.');
    for (const name of lockNames) {
      const providerSessionId = THREAD_LOCK_NAME.exec(name)![1];
      try {
        const lock = await fsp.stat(path.join(directory, name), { bigint: true });
        const pid = holders.get(getLinuxFileLockIdentity(lock.dev, lock.ino));
        if (!pid || pid <= 0) continue;

        const processDirectory = path.join(procRoot, String(pid));
        const [owner, executable, stat, command] = await Promise.all([
          fsp.stat(processDirectory),
          fsp.readlink(path.join(processDirectory, 'exe')),
          fsp.readFile(path.join(processDirectory, 'stat'), 'utf8'),
          fsp.readFile(path.join(processDirectory, 'cmdline'), 'utf8'),
        ]);
        if (owner.uid !== process.getuid?.() || path.basename(executable) !== 'codex') continue;

        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (!fields[19] || fields[0] === 'Z') continue;
        const args = command.split('\0').filter(Boolean);
        const execIndex = args.indexOf('exec');
        const resumeIndex = args.indexOf('resume', execIndex + 1);
        // Only a dedicated exec resume can be stopped by process id. An
        // app-server may own multiple threads and must never be killed here.
        const canInterrupt = execIndex > 0 && resumeIndex > execIndex
          && args.slice(resumeIndex + 1).includes(providerSessionId);
        // Dedicated exec processes finish when their turn exits. Persistent
        // TUI/app-server owners keep the lock even after task_complete.
        const activity = canInterrupt ? { isProcessing: true } : await readTurnActivity(getRolloutPath(providerSessionId));
        sessions.push({ providerSessionId, pid, procStart: fields[19], startedAt: activity.startedAt ?? Number(lock.mtimeMs), canInterrupt, isProcessing: activity.isProcessing });
      } catch (error) {
        if (['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
    }
    return sessions;
  }

  return {
    listSessions,

    async getSession(providerSessionId: string): Promise<CodexCliSession | null> {
      if (!THREAD_LOCK_NAME.test(`${providerSessionId}.lock`)) return null;
      return (await listSessions()).find((session) => session.providerSessionId === providerSessionId) ?? null;
    },

    async abortSession(providerSessionId: string): Promise<boolean> {
      const original = await this.getSession(providerSessionId);
      if (!original?.canInterrupt) return false;

      // Recheck both the kernel lock and process start time before signaling;
      // a PID reused since the UI poll must not receive a stop request.
      const current = await this.getSession(providerSessionId);
      if (!current?.canInterrupt || current.pid !== original.pid || current.procStart !== original.procStart) return false;
      try {
        signal(current.pid, 'SIGINT');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const live = await this.getSession(providerSessionId);
        if (!live) return true;
        if (live.pid !== current.pid || live.procStart !== current.procStart) return false;
        if (attempt === 19) {
          try {
            signal(current.pid, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        await delay(50);
      }
      return false;
    },
  };
}

/** Sessions uses ownership to guard send/fork, isProcessing for activity, and verified exec owners for Stop. */
export const codexCliLivenessService = createCodexCliLivenessService();
