import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session creation route names a CloudCLI session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('discard-unsent removes only sessions without an accepted first send', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('never-sent', 'codex', workspacePath);
    const discarded = await fetch(`${baseUrl}/api/providers/sessions/never-sent/discard-unsent`, {
      method: 'POST',
    });
    const discardedBody = await discarded.json() as { data: { status: string } };
    assert.equal(discarded.status, 200);
    assert.equal(discardedBody.data.status, 'deleted');
    assert.equal(sessionsDb.getSessionById('never-sent'), null);

    sessionsDb.createAppSession('accepted-send', 'codex', workspacePath);
    sessionsDb.recordAcceptedClientSend('accepted-send', 'request-1');
    const retained = await fetch(`${baseUrl}/api/providers/sessions/accepted-send/discard-unsent`, {
      method: 'POST',
    });
    const retainedBody = await retained.json() as { data: { status: string } };
    assert.equal(retainedBody.data.status, 'accepted');
    assert.ok(sessionsDb.getSessionById('accepted-send'));
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession(
      'title-only-session',
      'codex',
      workspacePath,
      'Release planning notes',
    );
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-search.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: {
        type: 'user_message',
        kind: 'plain',
        message: 'Release planning also appears in this conversation.',
      },
    })}\n`);
    sessionsDb.createSession(
      'transcript-session',
      'codex',
      workspacePath,
      'Unrelated session',
      undefined,
      undefined,
      transcriptPath,
    );

    const response = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
    );
    const eventStream = await response.text();
    const titleEventIndex = eventStream.indexOf('event: title-results');
    const conversationEventIndex = eventStream.indexOf('event: result');
    const doneEventIndex = eventStream.indexOf('event: done');

    assert.equal(response.status, 200);
    assert.ok(titleEventIndex >= 0);
    assert.ok(conversationEventIndex > titleEventIndex);
    assert.ok(doneEventIndex > titleEventIndex);

    const titleDataLine = eventStream
      .slice(titleEventIndex, conversationEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);

    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{
        sessionId: string;
        sessionTitle: string;
        provider: string;
      }>;
    };
    assert.equal(titlePayload.titleResults.length, 1);
    assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
    assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
    assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});
test('custom model routes accept, validate, and return reasoning-effort levels', async () => {
  await withProviderServer(async (baseUrl) => {
    const postModel = async (provider: string, body: unknown) => {
      const response = await fetch(`${baseUrl}/api/providers/${provider}/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: await response.json() as {
          data?: {
            model: { recordId: number; effort?: unknown };
            models: { OPTIONS: Array<{ value: string; effort?: unknown }> };
          };
          error?: { code: string; message?: string };
        },
      };
    };

    const created = await postModel('claude', {
      model: 'My Custom Model',
      id: 'my-custom-model',
      effort: { values: [' low ', 'high'], default: 'high' },
    });
    const expectedEffort = { default: 'high', values: [{ value: 'low' }, { value: 'high' }] };
    assert.equal(created.status, 201);
    assert.deepEqual(created.payload.data?.model.effort, expectedEffort);

    const catalogResponse = await fetch(`${baseUrl}/api/providers/claude/models`);
    const catalogPayload = await catalogResponse.json() as {
      data: { models: { OPTIONS: Array<{ value: string; effort?: unknown }>; EFFORT_LEVELS?: string[] } };
    };
    assert.deepEqual(
      catalogPayload.data.models.OPTIONS.find((option) => option.value === 'my-custom-model')?.effort,
      expectedEffort,
    );
    // The model library's toggles come from here, not from the built-in models.
    assert.deepEqual(
      catalogPayload.data.models.EFFORT_LEVELS,
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    );

    // OpenCode's allowed levels do not depend on which upstream providers the
    // machine running the tests has connected.
    const openCodeModel = await postModel('opencode', {
      model: 'Router model',
      id: 'openrouter/router-model',
      effort: { values: ['none', 'high'] },
    });
    assert.equal(openCodeModel.status, 201, JSON.stringify(openCodeModel.payload));
    assert.deepEqual(openCodeModel.payload.data?.model.effort, { values: [{ value: 'none' }, { value: 'high' }] });

    // A PATCH from a client that predates effort metadata keeps the levels.
    const renameResponse = await fetch(
      `${baseUrl}/api/providers/claude/models/${created.payload.data?.model.recordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Renamed', id: 'my-custom-model' }),
      },
    );
    const renamePayload = await renameResponse.json() as { data: { model: { effort?: unknown } } };
    assert.equal(renameResponse.status, 200);
    assert.deepEqual(renamePayload.data.model.effort, expectedEffort);

    const invalidPayloads: Array<{ provider: string; effort: unknown; code: string }> = [
      { provider: 'claude', effort: { values: ['low', 'low'] }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: { values: ['low', ''] }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: { values: ['low'], default: 'high' }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: { values: ['turbo'] }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: 'high', code: 'INVALID_MODEL_EFFORT' },
      { provider: 'cursor', effort: { values: ['low'] }, code: 'MODEL_EFFORT_NOT_SUPPORTED' },
    ];
    for (const [index, invalid] of invalidPayloads.entries()) {
      const rejected = await postModel(invalid.provider, {
        model: `Invalid ${index}`,
        id: `invalid-${index}`,
        effort: invalid.effort,
      });
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
      assert.equal(rejected.payload.error?.code, invalid.code, JSON.stringify(invalid));
    }

    // An oversized list is refused by its length, before any entry is walked:
    // the JSON parser accepts bodies of up to 50 MB.
    const oversized = await postModel('claude', {
      model: 'Oversized',
      id: 'oversized',
      effort: { values: Array.from({ length: 33 }, (_, index) => `level-${index}`) },
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.payload.error?.code, 'INVALID_MODEL_EFFORT');
    assert.match(oversized.payload.error?.message ?? '', /at most 32 effort levels/);
  });
});
