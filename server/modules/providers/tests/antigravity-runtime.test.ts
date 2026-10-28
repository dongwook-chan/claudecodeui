import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import {
  createAntigravityRuntime,
  resolveAntigravityPermissionArgs,
} from '@/modules/providers/list/antigravity/antigravity-runtime.provider.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const sessionsProvider = new AntigravitySessionsProvider();

function createRuntimeContext(
  overrides: Partial<ProviderRuntimeContext> = {},
): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

type FakeAntigravityProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: NodeJS.Signals): boolean;
};

function createFakeProcess(
  onKill?: (signal: NodeJS.Signals | undefined) => void,
): FakeAntigravityProcess {
  const child = new EventEmitter() as FakeAntigravityProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onKill?.(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function createWriter(onMessage?: (message: AnyRecord) => void): {
  writer: ProviderRuntimeWriter;
  messages: AnyRecord[];
  getProviderSessionId(): string | null;
} {
  const messages: AnyRecord[] = [];
  let providerSessionId: string | null = null;
  return {
    messages,
    getProviderSessionId: () => providerSessionId,
    writer: {
      userId: null,
      send(data) {
        const message = data as AnyRecord;
        messages.push(message);
        onMessage?.(message);
      },
      setSessionId(sessionId) {
        providerSessionId = sessionId;
      },
    },
  };
}

test('Antigravity permission modes map to agy controls', () => {
  assert.deepEqual(resolveAntigravityPermissionArgs('plan'), ['--mode', 'plan']);
  assert.deepEqual(resolveAntigravityPermissionArgs('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(resolveAntigravityPermissionArgs('bypassPermissions'), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolveAntigravityPermissionArgs('default'), []);
});

test('Antigravity streams stdout before exit and captures a new provider session id', async () => {
  const child = createFakeProcess();
  let capturedCommand = '';
  let capturedArgs: string[] = [];
  let capturedCwd = '';
  let historyReadCount = 0;
  const runtime = createAntigravityRuntime({
    spawnProcess: (command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedCwd = options.cwd;
      queueMicrotask(() => {
        child.stdout.write('assistant ');
        setTimeout(() => {
          child.stdout.end('response');
          child.emit('close', 0, null);
        }, 50);
      });
      return child as never;
    },
    readConversationDbFiles: async () => {
      historyReadCount += 1;
      return historyReadCount === 1
        ? []
        : [{ id: 'agy-native-session-1', mtimeMs: Date.now() }];
    },
  });

  let runCompleted = false;
  let resolveFirstDelta: (() => void) | null = null;
  const firstDelta = new Promise<void>((resolve) => {
    resolveFirstDelta = resolve;
  });
  const { writer, messages, getProviderSessionId } = createWriter((message) => {
    if (message.kind === 'stream_delta') {
      resolveFirstDelta?.();
    }
  });

  const run = runtime.run(
    'Hi',
    { cwd: '/workspace', sessionId: 'app-session-1', permissionMode: 'acceptEdits' },
    writer,
    createRuntimeContext(),
  ).then(() => {
    runCompleted = true;
  });

  await firstDelta;
  assert.equal(runCompleted, false);
  await run;

  const streamedText = messages
    .filter((message) => message.kind === 'stream_delta')
    .map((message) => String(message.content))
    .join('');
  assert.equal(streamedText, 'assistant response');
  assert.equal(getProviderSessionId(), 'agy-native-session-1');
  assert.equal(messages.some((message) => message.kind === 'session_created'), true);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
  assert.deepEqual(capturedArgs.slice(-2), ['--print', 'Hi']);
  assert.equal(capturedCommand, 'agyx');
  assert.equal(capturedArgs[capturedArgs.indexOf('--output-format') + 1], 'stream-json');
  assert.deepEqual(capturedArgs.slice(0, 2), ['session', '--']);
  assert.equal(capturedArgs.includes('--conversation'), false);
  assert.equal(capturedCwd, '/workspace');
});

test('Antigravity hides wait markers split across stdout chunks', async () => {
  const child = createFakeProcess();
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stdout.write('Before\n<WAITING_FOR_E');
        child.stdout.write('VENTS>\n</WAITING_');
        child.stdout.end('FOR_EVENTS>\nAfter');
        child.emit('close', 0, null);
      });
      return child as never;
    },
    readConversationDbFiles: async () => [],
  });
  const { writer, messages } = createWriter();
  await runtime.run('Hi', {}, writer, createRuntimeContext());

  const text = messages
    .filter((message) => message.kind === 'stream_delta')
    .map((message) => String(message.content))
    .join('');
  assert.match(text, /Before[\s\S]*After/);
  assert.equal(text.includes('WAITING_FOR_EVENTS'), false);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
});

test('Antigravity keeps the configured native AGY executable behind agyx', { concurrency: false }, async () => {
  const previousPath = process.env.AGY_CLI_PATH;
  const child = createFakeProcess();
  let capturedCommand = '';
  let capturedEnvironment: NodeJS.ProcessEnv = {};
  const runtime = createAntigravityRuntime({
    spawnProcess: (command, _args, options) => {
      capturedCommand = command;
      capturedEnvironment = options.env;
      queueMicrotask(() => child.emit('close', 0, null));
      return child as never;
    },
    readConversationDbFiles: async () => [],
  });

  try {
    process.env.AGY_CLI_PATH = '  "/opt/agent wrappers/agy"  ';
    await runtime.run('Hi', {}, createWriter().writer, createRuntimeContext());
    assert.equal(capturedCommand, 'agyx');
    assert.equal(capturedEnvironment.AGYX_REAL_AGY, '/opt/agent wrappers/agy');
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGY_CLI_PATH;
    } else {
      process.env.AGY_CLI_PATH = previousPath;
    }
  }
});

test('Antigravity supports a configured agyx path without changing the resumed turn', { concurrency: false }, async () => {
  const previousPath = process.env.AGYX_CLI_PATH;
  const child = createFakeProcess();
  let capturedCommand = '';
  let capturedArgs: string[] = [];
  const runtime = createAntigravityRuntime({
    spawnProcess: (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      queueMicrotask(() => child.emit('close', 0, null));
      return child as never;
    },
    readConversationDbFiles: async () => [],
  });

  try {
    process.env.AGYX_CLI_PATH = '  "/opt/agent wrappers/agyx"  ';
    await runtime.run(
      'continue\nCheck existing files first.',
      { sessionId: 'app-resume', model: 'gemini-3.8-flash-high', permissionMode: 'plan' },
      createWriter().writer,
      createRuntimeContext({ resolveProviderSessionId: () => 'native-resume' }),
    );
    assert.equal(capturedCommand, '/opt/agent wrappers/agyx');
    assert.deepEqual(capturedArgs, [
      'session', '--', '--conversation', 'native-resume',
      '--model', 'gemini-3.8-flash-high', '--mode', 'plan',
      '--output-format', 'stream-json',
      '--print', 'continue\nCheck existing files first.',
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.AGYX_CLI_PATH;
    else process.env.AGYX_CLI_PATH = previousPath;
  }
});

test('Antigravity resumes with the provider-native conversation id', async () => {
  const child = createFakeProcess();
  let capturedArgs: string[] = [];
  const runtime = createAntigravityRuntime({
    spawnProcess: (_command, args) => {
      capturedArgs = args;
      queueMicrotask(() => child.emit('close', 0, null));
      return child as never;
    },
    readConversationDbFiles: async () => [],
  });
  const { writer, getProviderSessionId } = createWriter();

  await runtime.run(
    'Continue',
    { sessionId: 'app-session-2' },
    writer,
    createRuntimeContext({
      resolveProviderSessionId: (sessionId) => (
        sessionId === 'app-session-2' ? 'agy-existing-session' : null
      ),
    }),
  );

  const conversationIndex = capturedArgs.indexOf('--conversation');
  assert.notEqual(conversationIndex, -1);
  assert.equal(capturedArgs[conversationIndex + 1], 'agy-existing-session');
  assert.equal(getProviderSessionId(), 'agy-existing-session');
});

test('Antigravity abort sends SIGTERM and leaves the aborted complete to the gateway', async () => {
  let receivedSignal: NodeJS.Signals | undefined;
  const child = createFakeProcess((signal) => {
    receivedSignal = signal;
  });
  let resolveSpawned: (() => void) | null = null;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawned = resolve;
  });
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      resolveSpawned?.();
      return child as never;
    },
    readConversationDbFiles: async () => [],
  });
  const { writer, messages } = createWriter();
  const run = runtime.run(
    'Wait',
    { sessionId: 'app-session-abort' },
    writer,
    createRuntimeContext(),
  );

  await spawned;
  assert.equal(await runtime.abort('app-session-abort'), true);
  await run;

  assert.equal(receivedSignal, 'SIGTERM');
  assert.equal(messages.some((message) => message.kind === 'complete'), false);
});

test('Antigravity reports model-resolution failures as terminal errors', async () => {
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      throw new Error('process must not start');
    },
    readConversationDbFiles: async () => [],
  });
  const { writer, messages } = createWriter();
  await assert.rejects(
    runtime.run(
      'Hi',
      { sessionId: 'app-session-model-error' },
      writer,
      createRuntimeContext({
        resolveResumeModel: async () => {
          throw new Error('model lookup failed');
        },
      }),
    ),
    /model lookup failed/,
  );

  assert.equal(messages.some((message) => message.kind === 'error'), true);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
});

test('Antigravity emits one terminal lifecycle when the CLI cannot spawn', async () => {
  const child = createFakeProcess();
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      queueMicrotask(() => {
        child.emit('error', new Error('spawn agy ENOENT'));
        child.emit('close', -2, null);
      });
      return child as never;
    },
    readConversationDbFiles: async () => [],
  });
  const { writer, messages } = createWriter();

  await assert.rejects(
    runtime.run('Hi', { sessionId: 'app-session-spawn-error' }, writer, createRuntimeContext({
      isProviderInstalled: async () => false,
    })),
    /spawn agy ENOENT/,
  );

  assert.equal(messages.filter((message) => message.kind === 'error').length, 1);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
});


test('Antigravity binds split native init immediately and delivers transcript rows before exit', async () => {
  const child = createFakeProcess();
  const rows: NormalizedMessage[] = [{
    id: 'app-live-0', sessionId: 'app-live', provider: 'antigravity',
    timestamp: new Date().toISOString(), kind: 'text', role: 'user', content: 'Hi',
  }];
  let reads = 0;
  let started: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => { started = resolve; });
  const runtime = createAntigravityRuntime({
    spawnProcess: () => { started?.(); return child as never; },
    // Simulate an unrelated concurrent AGY conversation; init is authoritative.
    readConversationDbFiles: async () => [{ id: 'unrelated-native', mtimeMs: Date.now() }],
    readHistory: async (appId, nativeId) => {
      reads++;
      assert.equal(appId, 'app-live');
      assert.equal(nativeId, 'native-live');
      return [...rows];
    },
  });
  const { writer, messages, getProviderSessionId } = createWriter();
  const run = runtime.run('Hi', { sessionId: 'app-live' }, writer, createRuntimeContext());
  await spawned;
  child.stdout.write('{"event":"init","conversation_');
  assert.equal(getProviderSessionId(), null);
  child.stdout.write('id":"native-live","init":{"cwd":"/workspace","tools":["read_file"]}}\n');
  assert.equal(getProviderSessionId(), 'native-live');
  child.stdout.write('{"event":"step_update","step_update":{"conversation_id":"native-live","step_index":0,"state":"DONE","step_type":"user_input"}}\n');
  child.stdout.write('{bad-json}\n');
  await delay(140);
  assert.equal(reads, 1, 'init and step bursts are coalesced');
  assert.equal(messages.some((message) => message.content === 'Hi'), true);
  assert.equal(messages.some((message) => message.kind === 'complete'), false);

  rows.push({ ...rows[0], id: 'app-live-2', kind: 'thinking', role: 'assistant', content: 'Checking files' });
  child.stdout.write('{"event":"step_update","step_update":{"conversation_id":"native-live","step_index":2,"state":"DONE"}}\n');
  await delay(140);
  assert.equal(messages.some((message) => message.content === 'Checking files'), true);
  assert.equal(messages.filter((message) => message.content === 'Hi').length, 1);
  child.emit('close', 0, null);
  await run;
  assert.equal(messages.filter((message) => message.kind === 'session_created').length, 1);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
  assert.equal(messages.some((message) => String(message.content).includes('"event"')), false);
});

test('Antigravity resumes without replaying history and flushes final JSON without a newline', async () => {
  const child = createFakeProcess();
  const oldRow: NormalizedMessage = {
    id: 'app-resume-0', sessionId: 'app-resume', provider: 'antigravity',
    timestamp: new Date().toISOString(), kind: 'text', role: 'assistant', content: 'Earlier reply',
  };
  let reads = 0;
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      queueMicrotask(() => {
        const wire = Buffer.from('{"event":"init","conversation_id":"native-resume","init":{"cwd":"한글"}}\n');
        const split = wire.indexOf(Buffer.from('한')) + 1;
        child.stdout.write(wire.subarray(0, split));
        child.stdout.write(wire.subarray(split));
        child.stdout.write('{"event":"result","result":{"conversation_id":"native-resume","status":"SUCCESS","response":"New reply"}}');
        child.emit('close', 0, null);
      });
      return child as never;
    },
    readConversationDbFiles: async () => [],
    readHistory: async () => {
      reads++;
      return reads === 1 ? [oldRow] : [oldRow, { ...oldRow, id: 'app-resume-3', content: 'New reply' }];
    },
  });
  const { writer, messages } = createWriter();
  await runtime.run('Continue', { sessionId: 'app-resume' }, writer,
    createRuntimeContext({ resolveProviderSessionId: () => 'native-resume' }));
  assert.equal(messages.some((message) => message.content === 'Earlier reply'), false);
  assert.equal(messages.filter((message) => message.content === 'New reply').length, 1);
  assert.equal(messages.some((message) => message.kind === 'stream_delta'), false);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
});

test('Antigravity native result is not terminal until the managed launcher exits, and Stop cancels pending hydration', async () => {
  const child = createFakeProcess();
  let started: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => { started = resolve; });
  let reads = 0;
  const runtime = createAntigravityRuntime({
    spawnProcess: () => { started?.(); return child as never; },
    readConversationDbFiles: async () => [],
    readHistory: async () => { reads++; return []; },
  });
  const { writer, messages } = createWriter();
  const run = runtime.run('Hi', { sessionId: 'app-stop' }, writer, createRuntimeContext());
  await spawned;
  child.stdout.write('{"event":"init","conversation_id":"native-stop"}\n');
  child.stdout.write('{"event":"result","result":{"conversation_id":"native-stop","status":"ERROR","error":"RESOURCE_EXHAUSTED"}}\n');
  assert.equal(messages.some((message) => message.kind === 'complete'), false);
  assert.equal(runtime.abort('app-stop'), true);
  await run;
  await delay(140);
  assert.equal(reads, 0);
  assert.equal(messages.some((message) => message.kind === 'complete'), false);
});


test('Antigravity native init hydrates the real transcript while the process is still running', { concurrency: false }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'agy-live-history-'));
  const previousHome = process.env.HOME;
  const child = createFakeProcess();
  const nativeId = 'native-live-filesystem';
  const logsDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', nativeId, '.system_generated', 'logs');
  let receivedUser: (() => void) | undefined;
  const userVisible = new Promise<void>((resolve) => { receivedUser = resolve; });
  try {
    process.env.HOME = homeDir;
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, 'transcript.jsonl'), JSON.stringify({
      step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
      created_at: '2026-10-28T00:28:20Z', content: '<USER_REQUEST>Live user prompt</USER_REQUEST>',
    }) + '\n');
    const runtime = createAntigravityRuntime({
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(JSON.stringify({
          event: 'init', conversation_id: nativeId, init: { cwd: '/workspace' },
        }) + '\n'));
        return child as never;
      },
      readConversationDbFiles: async () => [],
    });
    const { writer, messages, getProviderSessionId } = createWriter((message) => {
      if (message.content === 'Live user prompt') receivedUser?.();
    });
    const run = runtime.run('Live user prompt', { sessionId: 'app-filesystem' }, writer, createRuntimeContext());
    try {
      await Promise.race([userVisible, delay(2000).then(() => { throw new Error('Live transcript stayed empty'); })]);
      assert.equal(getProviderSessionId(), nativeId);
      assert.equal(messages.some((message) => message.kind === 'complete'), false);
      assert.equal(messages.find((message) => message.content === 'Live user prompt')?.id, 'app-filesystem-0');
    } finally {
      child.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: nativeId, response: 'Final reply' } }));
      child.emit('close', 0, null);
      await run;
    }
    assert.equal(messages.filter((message) => message.content === 'Final reply').length, 1);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(homeDir, { recursive: true, force: true });
  }
});
