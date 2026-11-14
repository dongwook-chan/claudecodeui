import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { readProtobufFields, sanitizeLeafDirectoryName } from '@/shared/index.js';

type TurnBoundary = { databasePath: string; lastStepIndex: number; errors: Set<string> };
type NativeStep = { idx: number; step_type: number; status: number; step_payload: unknown };

function field(payload: Buffer, number: number): Buffer | null {
  const value = readProtobufFields(payload).get(number)?.[0];
  return Buffer.isBuffer(value) ? value : null;
}

function errorSummary(payload: unknown): string | null {
  if (!Buffer.isBuffer(payload)) return null;
  const step = field(payload, 24);
  const details = step && field(step, 3);
  const summary = details && field(details, 1);
  return summary ? new TextDecoder('utf-8', { fatal: true }).decode(summary).trim() : null;
}

/** Providers' AGY runtime snapshots persisted errors before sending a resumed turn. */
export function captureAntigravityTurnBoundary(conversationId: string | null): TurnBoundary | null {
  if (!conversationId) return null;
  try {
    const id = sanitizeLeafDirectoryName(conversationId, 'Antigravity session id');
    const databasePath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${id}.db`);
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      return database.transaction(() => {
        const last = database.prepare('SELECT MAX(idx) AS idx FROM steps').get() as { idx: number | null };
        if (!Number.isSafeInteger(last.idx) || last.idx === null || last.idx < 0) return null;
        const errors = new Set<string>();
        const rows = database.prepare('SELECT step_payload FROM steps WHERE step_type = 17 AND idx <= ?')
          .all(last.idx) as Array<{ step_payload: unknown }>;
        for (const row of rows) {
          const summary = errorSummary(row.step_payload);
          if (summary) errors.add(summary);
        }
        return { databasePath, lastStepIndex: last.idx, errors };
      })();
    } finally { database.close(); }
  } catch {
    // Missing, locked or unfamiliar native stores cannot establish a stale result.
    return null;
  }
}

/** Providers' AGY runtime uses fresh native completion evidence to reject replayed result errors. */
export function isHistoricalAntigravityResultError(boundary: TurnBoundary | null, error: string): boolean {
  if (!boundary?.errors.has(error)) return false;
  try {
    const database = new Database(boundary.databasePath, { readonly: true, fileMustExist: true });
    try {
      return database.transaction(() => {
        const rows = database.prepare('SELECT idx, step_type, status, step_payload FROM steps WHERE idx > ? ORDER BY idx')
          .all(boundary.lastStepIndex) as NativeStep[];
        // A partial answer or a new terminal error must retain the failed result,
        // even when its error text happens to match an older quota failure.
        if (rows[0]?.step_type !== 14 || rows.filter((row) => row.step_type === 14).length !== 1
          || rows.some((row) => row.step_type === 17)) return false;
        const last = rows.at(-1);
        if (!last || last.step_type !== 15 || last.status !== 3 || !Buffer.isBuffer(last.step_payload)) return false;
        const planner = field(last.step_payload, 20);
        if (!planner) return false;
        const fields = readProtobufFields(planner);
        // Native planner field 7 contains tool calls; these are intermediate steps.
        if (fields.has(7)) return false;
        const text = fields.get(1)?.[0];
        if (!Buffer.isBuffer(text)) return false;
        const answer = new TextDecoder('utf-8', { fatal: true }).decode(text).trim();
        return answer.length > 0 && !/^<WAITING_FOR_EVENTS>\s*<\/WAITING_FOR_EVENTS>$/.test(answer);
      })();
    } finally { database.close(); }
  } catch {
    return false;
  }
}
