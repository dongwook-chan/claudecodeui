import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import crossSpawn from 'cross-spawn';

import { AntigravitySessionsProvider } from './antigravity-sessions.provider.js';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  buildProviderCliEnv,
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  resolveConfiguredCliExecutable,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

type AntigravityProcess = ReturnType<typeof crossSpawn> & {
  aborted?: boolean;
  sessionId?: string;
};

type ConversationDbFile = {
  id: string;
  mtimeMs: number;
};

type AntigravitySpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ['pipe', 'pipe', 'pipe'];
    env: NodeJS.ProcessEnv;
  },
) => AntigravityProcess;

type AntigravityRuntimeDependencies = {
  spawnProcess: AntigravitySpawn;
  readConversationDbFiles: () => Promise<ConversationDbFile[]>;
  readHistory: (sessionId: string, providerSessionId: string) => Promise<NormalizedMessage[]>;
};

/** Reads a trimmed runtime option without accepting blank values. */
function readStringOption(options: AnyRecord, key: string): string | null {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Resolves the provider-native conversation database directory. */
function getAntigravityConversationsDir(): string {
  return process.env.ANTIGRAVITY_CONVERSATIONS_DIR
    || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
}

/** Lists AGY conversation databases used to discover newly created sessions. */
async function readAntigravityConversationDbFiles(): Promise<ConversationDbFile[]> {
  try {
    const conversationsDir = getAntigravityConversationsDir();
    const entries = await readdir(conversationsDir, { withFileTypes: true });
    const dbFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.db'));

    return Promise.all(dbFiles.map(async (entry) => {
      const absolutePath = path.join(conversationsDir, entry.name);
      const fileStat = await stat(absolutePath);
      return {
        id: entry.name.slice(0, -'.db'.length),
        mtimeMs: fileStat.mtimeMs,
      };
    }));
  } catch {
    return [];
  }
}

/** Selects the newest conversation created by the current runtime invocation. */
async function findNewAntigravityConversationId(
  previousIds: Set<string>,
  startedAtMs: number,
  readConversationDbFiles: () => Promise<ConversationDbFile[]>,
): Promise<string | null> {
  const candidates = (await readConversationDbFiles())
    .filter((entry) => !previousIds.has(entry.id) && entry.mtimeMs >= startedAtMs - 1000)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.id ?? null;
}

/** Publishes a provider-native session id discovered after AGY starts. */
function announceAntigravityConversation(
  writer: ProviderRuntimeWriter,
  conversationId: string,
): void {
  writer.setSessionId?.(conversationId);
  writer.send(createNormalizedMessage({
    kind: 'session_created',
    newSessionId: conversationId,
    sessionId: conversationId,
    provider: 'antigravity',
  }));
}

/** Normalizes and forwards one incremental AGY output chunk. */
function sendAntigravityText(
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
  text: string,
  sessionId: string | null,
): void {
  for (const message of context.normalizeMessage(text, sessionId)) {
    writer.send(message);
  }
}

const AGY_CONTROL_MARKERS = ['<WAITING_FOR_EVENTS>', '</WAITING_FOR_EVENTS>'] as const;

/** Keeps split AGY control tags out of the text stream while forwarding ordinary text immediately. */
function createAntigravityStdoutFilter(sendVisibleText: (text: string) => void) {
  let pending = '';
  return {
    write(chunk: string) {
      pending += chunk;
      for (const marker of AGY_CONTROL_MARKERS) pending = pending.replaceAll(marker, '');

      let heldLength = 0;
      for (const marker of AGY_CONTROL_MARKERS) {
        for (let length = 1; length < marker.length; length += 1) {
          if (pending.endsWith(marker.slice(0, length))) heldLength = Math.max(heldLength, length);
        }
      }
      const visible = pending.slice(0, pending.length - heldLength);
      pending = pending.slice(visible.length);
      if (visible) sendVisibleText(visible);
    },
    finish() {
      // Only a partial control tag can remain after write() has emitted the visible prefix.
      pending = '';
    },
  };
}

/**
 * Maps CloudCLI permission modes to the Antigravity CLI flags consumed by the
 * runtime adapter. Exported for the Providers module runtime tests.
 */
export function resolveAntigravityPermissionArgs(permissionMode: unknown): string[] {
  switch (permissionMode) {
    case 'plan':
      return ['--mode', 'plan'];
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'bypassPermissions':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

/** Runs one AGY turn through agyx so its managed launcher owns recovery and child signals. */
async function runAntigravity(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
  dependencies: AntigravityRuntimeDependencies,
  activeProcesses: Map<string, AntigravityProcess>,
): Promise<void> {
  const appSessionId = readStringOption(options, 'sessionId');
  const providerSessionId = context.resolveProviderSessionId(appSessionId);
  const fallbackSessionId = appSessionId ?? providerSessionId ?? `${Date.now()}`;
  const processKey = appSessionId ?? providerSessionId ?? fallbackSessionId;
  const workingDirectory = readStringOption(options, 'cwd')
    ?? readStringOption(options, 'projectPath')
    ?? process.cwd();
  const sessionSummary = readStringOption(options, 'sessionSummary');
  const requestedModel = readStringOption(options, 'model');
  const startedAtMs = Date.now();
  const previousConversationIds = new Set(
    (await dependencies.readConversationDbFiles()).map((entry) => entry.id),
  );

  if (providerSessionId) {
    writer.setSessionId?.(providerSessionId);
  }

  let terminalNotificationSent = false;
  const notifyTerminalState = (
    outcome: { code?: number | null; error?: Error | string | null; aborted?: boolean },
  ) => {
    if (terminalNotificationSent) {
      return;
    }

    terminalNotificationSent = true;
    if (outcome.aborted || (outcome.code === 0 && !outcome.error)) {
      notifyRunStopped({
        userId: writer.userId ?? null,
        provider: 'antigravity',
        sessionId: fallbackSessionId,
        sessionName: sessionSummary,
        stopReason: outcome.aborted ? 'aborted' : 'completed',
      });
      return;
    }

    notifyRunFailed({
      userId: writer.userId ?? null,
      provider: 'antigravity',
      sessionId: fallbackSessionId,
      sessionName: sessionSummary,
      error: outcome.error ?? `Antigravity CLI exited with code ${outcome.code ?? 'unknown'}`,
    });
  };

  let resolvedModel: string | undefined;
  try {
    resolvedModel = await context.resolveResumeModel(appSessionId ?? undefined, requestedModel);
  } catch (error) {
    const resolvedError = error instanceof Error ? error : new Error(String(error));
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: resolvedError.message,
      sessionId: providerSessionId ?? fallbackSessionId,
      provider: 'antigravity',
    }));
    writer.send(createCompleteMessage({
      provider: 'antigravity',
      sessionId: providerSessionId ?? fallbackSessionId,
      exitCode: 1,
    }));
    notifyTerminalState({ error: resolvedError });
    throw resolvedError;
  }

  const args: string[] = ['session', '--'];
  if (providerSessionId) {
    args.push('--conversation', providerSessionId);
  }
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }
  args.push(...resolveAntigravityPermissionArgs(options.permissionMode));
  args.push('--output-format', 'stream-json');
  args.push('--print', flattenPromptForWindowsShell(command.trim()));

  const cliEnvironment = buildProviderCliEnv();
  if (process.env.AGY_CLI_PATH?.trim()) {
    // Keep native CLI overrides behind the supervisor rather than bypassing it.
    cliEnvironment.AGYX_REAL_AGY = resolveConfiguredCliExecutable(process.env.AGY_CLI_PATH, 'agy');
  }

  // Ignore already-persisted rows on resume. Live rows retain the same ids as
  // the history endpoint so reconnect/reload reconciliation can remove echoes.
  const emittedHistoryIds = new Set<string>();
  if (providerSessionId) {
    try {
      for (const message of await dependencies.readHistory(fallbackSessionId, providerSessionId)) {
        emittedHistoryIds.add(message.id);
      }
    } catch {
      // History is supplementary; an unavailable transcript must not block a turn.
    }
  }

  return new Promise((resolve, reject) => {
    const antigravityProcess = dependencies.spawnProcess(
      resolveConfiguredCliExecutable(process.env.AGYX_CLI_PATH, 'agyx'),
      args,
      {
        cwd: workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cliEnvironment,
      },
    ) as AntigravityProcess;
    let stderrBuffer = '';
    let settled = false;
    let completeSent = false;
    let spawnError: Error | null = null;
    let liveConversationId = providerSessionId;
    let historyTimer: ReturnType<typeof setTimeout> | null = null;
    let historyQueue = Promise.resolve();
    let structuredOutput = false;
    let pendingJson = '';
    let resultResponse = '';
    const emittedAssistantContents = new Set<string>();
    const decoder = new StringDecoder('utf8');
    const stdoutFilter = createAntigravityStdoutFilter((text) => {
      sendAntigravityText(writer, context, text, liveConversationId ?? fallbackSessionId);
    });

    const refreshHistory = async () => {
      if (!liveConversationId || antigravityProcess.aborted || spawnError) return;
      try {
        const messages = await dependencies.readHistory(fallbackSessionId, liveConversationId);
        if (antigravityProcess.aborted || spawnError) return;
        for (const message of messages) {
          if (emittedHistoryIds.has(message.id)) continue;
          emittedHistoryIds.add(message.id);
          if (message.kind === 'text' && message.role === 'assistant') {
            emittedAssistantContents.add(message.content?.trim() ?? '');
          }
          writer.send(message);
        }
      } catch {
        // AGY can announce a step before flushing its transcript; the next
        // update (and final close) retries without turning a live run into an error.
      }
    };
    const scheduleHistoryRefresh = () => {
      if (historyTimer) return;
      // Coalesce token/step bursts and let AGY flush the JSONL row first.
      historyTimer = setTimeout(() => {
        historyTimer = null;
        historyQueue = historyQueue.then(refreshHistory);
      }, 100);
    };
    const handleJsonLine = (line: string) => {
      let event: AnyRecord | null;
      try {
        event = readObjectRecord(JSON.parse(line));
      } catch {
        return;
      }
      if (!event) return;
      const step = readObjectRecord(event.step_update);
      const result = readObjectRecord(event.result);
      const conversationId = readOptionalString(event.conversation_id)
        ?? readOptionalString(step?.conversation_id)
        ?? readOptionalString(result?.conversation_id);
      if (conversationId && conversationId !== liveConversationId) {
        liveConversationId = conversationId;
        announceAntigravityConversation(writer, conversationId);
      }
      if (event.event === 'init' || event.event === 'step_update' || event.event === 'result') {
        structuredOutput = true;
        if (event.event === 'result') resultResponse = readOptionalString(result?.response) ?? '';
        // Completed steps are persisted rows. Token deltas may arrive much
        // faster than disk changes, so do not reparse the transcript per token.
        if (event.event !== 'step_update' || step?.state === 'DONE') scheduleHistoryRefresh();
      }
    };
    const consumeStdout = (text: string) => {
      // Older native fixtures/CLIs can still produce ordinary text. Never
      // expose the native JSON envelope or its init metadata as assistant text.
      if (!pendingJson && !text.trimStart().startsWith('{')) {
        if (!structuredOutput) stdoutFilter.write(text);
        return;
      }
      pendingJson += text;
      let newline: number;
      while ((newline = pendingJson.indexOf('\n')) >= 0) {
        const line = pendingJson.slice(0, newline).trim();
        pendingJson = pendingJson.slice(newline + 1);
        if (line) handleJsonLine(line);
      }
    };

    const settle = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    activeProcesses.set(processKey, antigravityProcess);
    antigravityProcess.sessionId = processKey;
    antigravityProcess.stdin?.end();

    antigravityProcess.stdout?.on('data', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : decoder.write(data);
      if (text) consumeStdout(text);
    });

    antigravityProcess.stderr?.on('data', (data: Buffer | string) => {
      stderrBuffer += data.toString();
    });

    antigravityProcess.once('close', async (code) => {
      consumeStdout(decoder.end());
      if (pendingJson.trim()) handleJsonLine(pendingJson.trim());
      if (historyTimer) clearTimeout(historyTimer);
      stdoutFilter.finish();
      activeProcesses.delete(processKey);
      if (spawnError) {
        return;
      }

      await historyQueue;
      if (structuredOutput) await refreshHistory();
      if (code === 0 && resultResponse && !emittedAssistantContents.has(resultResponse.trim()) && !antigravityProcess.aborted) {
        sendAntigravityText(writer, context, resultResponse, liveConversationId ?? fallbackSessionId);
      }

      const discoveredConversationId = liveConversationId
        ?? await findNewAntigravityConversationId(
          previousConversationIds,
          startedAtMs,
          dependencies.readConversationDbFiles,
        );
      const outputSessionId = discoveredConversationId ?? fallbackSessionId;
      if (!liveConversationId && discoveredConversationId) {
        announceAntigravityConversation(writer, discoveredConversationId);
      }

      if (stderrBuffer.trim()) {
        writer.send(createNormalizedMessage({
          kind: code === 0 ? 'stream_delta' : 'error',
          content: stderrBuffer,
          sessionId: outputSessionId,
          provider: 'antigravity',
        }));
      }

      if (antigravityProcess.aborted) {
        // The generic websocket abort handler owns the terminal aborted frame.
        notifyTerminalState({ aborted: true });
        settle();
        return;
      }

      if (!completeSent) {
        completeSent = true;
        writer.send(createCompleteMessage({
          provider: 'antigravity',
          sessionId: outputSessionId,
          exitCode: code,
        }));
      }

      if (code === 0) {
        notifyTerminalState({ code });
        settle();
        return;
      }

      if (code === 127 || code === null) {
        const installed = await context.isProviderInstalled();
        if (!installed) {
          writer.send(createNormalizedMessage({
            kind: 'error',
            content: 'Antigravity CLI is not installed. Install it from https://antigravity.google/cli/install.sh',
            sessionId: outputSessionId,
            provider: 'antigravity',
          }));
        }
      }

      const error = new Error(
        code === null
          ? 'Antigravity CLI process was terminated'
          : `Antigravity CLI exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`,
      );
      notifyTerminalState({ code, error });
      settle(error);
    });

    antigravityProcess.once('error', async (error) => {
      spawnError = error;
      if (historyTimer) clearTimeout(historyTimer);
      activeProcesses.delete(processKey);
      if (antigravityProcess.aborted) {
        notifyTerminalState({ aborted: true });
        settle();
        return;
      }

      const installed = await context.isProviderInstalled();
      const errorContent = !installed
        ? 'Antigravity CLI is not installed. Install it from https://antigravity.google/cli/install.sh'
        : error.message;

      writer.send(createNormalizedMessage({
        kind: 'error',
        content: errorContent,
        sessionId: providerSessionId ?? fallbackSessionId,
        provider: 'antigravity',
      }));
      if (!completeSent && !antigravityProcess.aborted) {
        completeSent = true;
        writer.send(createCompleteMessage({
          provider: 'antigravity',
          sessionId: providerSessionId ?? fallbackSessionId,
          exitCode: 1,
        }));
      }
      notifyTerminalState({ error });
      settle(error);
    });
  });
}

/** Terminates an active AGY process by application or provider session id. */
function abortAntigravitySession(
  sessionId: string,
  activeProcesses: Map<string, AntigravityProcess>,
): boolean {
  const activeProcess = activeProcesses.get(sessionId);
  if (!activeProcess) {
    return false;
  }

  activeProcess.aborted = true;
  activeProcess.kill('SIGTERM');
  activeProcesses.delete(sessionId);
  return true;
}

/**
 * Creates an Antigravity runtime adapter with injectable process and history
 * dependencies. The provider registry uses the defaults; Providers module
 * tests inject deterministic in-memory subprocesses.
 */
export function createAntigravityRuntime(
  overrides: Partial<AntigravityRuntimeDependencies> = {},
): IProviderRuntime {
  const dependencies: AntigravityRuntimeDependencies = {
    spawnProcess: crossSpawn as AntigravitySpawn,
    readConversationDbFiles: readAntigravityConversationDbFiles,
    readHistory: async (sessionId, nativeId) => (
      new AntigravitySessionsProvider().fetchHistory(sessionId, { providerSessionId: nativeId })
    ).then((history) => history.messages),
    ...overrides,
  };
  const activeProcesses = new Map<string, AntigravityProcess>();

  return {
    run: (command, options, writer, context) => (
      runAntigravity(command, options, writer, context, dependencies, activeProcesses)
    ),
    abort: (sessionId) => abortAntigravitySession(sessionId, activeProcesses),
  };
}

/** Runtime adapter consumed by the Providers registry and runtime service. */
export const antigravityRuntime: IProviderRuntime = createAntigravityRuntime();
