import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type CodexCliSession = {
  providerSessionId: string;
  pid: number;
  procStart: string;
  startedAt: number;
  canInterrupt: boolean;
};

type LivenessOptions = {
  procRoot?: string;
  getCodexHome?: () => string;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
};

const THREAD_LOCK_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
const MAX_LOCK_FILES = 4096;

/** Match Linux's device/inode lock identity, including extended device numbers. */
function lockIdentity(device: bigint, inode: bigint): string {
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return `${major.toString(16)}:${minor.toString(16)}:${inode}`;
}

/** Providers uses this factory to inspect native writer locks; tests use isolated procfs fixtures. */
export function createCodexCliLivenessService(options: LivenessOptions = {}) {
  const procRoot = options.procRoot ?? '/proc';
  const getCodexHome = options.getCodexHome
    ?? (() => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const signal = options.signal ?? ((pid: number, value: NodeJS.Signals) => { process.kill(pid, value); });

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

    const holders = new Map<string, number>();
    for (const line of locks.split('\n')) {
      // A queued lock ("->"), shared lock, or stale file proves no ownership.
      const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([\da-f]+):([\da-f]+):(\d+)\s+0\s+EOF\s*$/i.exec(line);
      if (!match) continue;
      const key = `${BigInt(`0x${match[2]}`).toString(16)}:${BigInt(`0x${match[3]}`).toString(16)}:${match[4]}`;
      holders.set(key, Number(match[1]));
    }

    const sessions: CodexCliSession[] = [];
    const lockNames = names.filter((name) => THREAD_LOCK_NAME.test(name));
    if (lockNames.length > MAX_LOCK_FILES) throw new Error('Too many Codex writer locks to inspect safely.');
    for (const name of lockNames) {
      const providerSessionId = THREAD_LOCK_NAME.exec(name)![1];
      try {
        const lock = await fsp.stat(path.join(directory, name), { bigint: true });
        const pid = holders.get(lockIdentity(lock.dev, lock.ino));
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
        sessions.push({ providerSessionId, pid, procStart: fields[19], startedAt: Number(lock.mtimeMs), canInterrupt });
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

/** Sessions service uses native writer ownership to report and stop external Codex turns. */
export const codexCliLivenessService = createCodexCliLivenessService();
