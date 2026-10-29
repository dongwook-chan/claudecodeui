import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import type { LLMProvider, ProjectSession } from '@/shared/types';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'antigravity'];
const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({
        success: true,
        data: {
          providers: ['claude', 'cursor', 'codex', 'opencode', 'antigravity'].map((provider) => ({
            provider, permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
            defaultPermissionMode: 'default',
          })),
        },
      }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
    },
  },
}));

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

afterEach(() => {
  resetUserPreferences();
});

test.each(PROVIDERS)('%s ignores stored modes across new chats, restored sessions and mode shortcuts', async (provider) => {
  writeUserPreference('selectedProvider', provider);
  localStorage.setItem('permissionMode-old-session', 'default');
  localStorage.setItem('permissionMode-last-' + provider, 'plan');
  localStorage.setItem('codex-settings', JSON.stringify({ permissionMode: 'default' }));
  const readStorage = vi.spyOn(Storage.prototype, 'getItem');
  const writeStorage = vi.spyOn(Storage.prototype, 'setItem');
  const view = renderHook(({ selectedSession }: { selectedSession: ProjectSession | null }) => (
    useChatProviderState({ selectedSession, selectedProject: null })
  ), { initialProps: { selectedSession: null } as { selectedSession: ProjectSession | null } });

  // The first render must already use bypass, before async capabilities load.
  assert.equal(view.result.current.permissionMode, 'bypassPermissions');
  await waitFor(() => assert.equal(view.result.current.providerModelsLoading, false));
  assert.deepEqual(view.result.current.availablePermissionModes, ['bypassPermissions']);
  view.rerender({ selectedSession: { id: 'old-session', __provider: provider } });
  assert.equal(view.result.current.permissionMode, 'bypassPermissions');
  act(() => {
    view.result.current.selectPermissionMode('default');
    view.result.current.cyclePermissionMode();
  });
  assert.equal(view.result.current.permissionMode, 'bypassPermissions');
  view.rerender({ selectedSession: { id: 'new-session', __provider: provider } });
  assert.equal(view.result.current.permissionMode, 'bypassPermissions');
  for (const targetProvider of PROVIDERS) {
    for (const storedMode of ['default', 'acceptEdits', 'plan', 'invalid']) {
      assert.equal(view.result.current.resolvePermissionModeForProvider(targetProvider, storedMode), 'bypassPermissions');
    }
  }
  assert.equal(readStorage.mock.calls.some(([key]) => key.startsWith('permissionMode-')), false);
  assert.equal(writeStorage.mock.calls.some(([key]) => key.startsWith('permissionMode-')), false);
});

test('switching an existing session to another provider retains bypass', async () => {
  const view = renderHook(({ selectedSession }: { selectedSession: ProjectSession }) => (
    useChatProviderState({ selectedSession, selectedProject: null })
  ), { initialProps: { selectedSession: { id: 'claude-session', __provider: 'claude' } as ProjectSession } });
  for (const provider of PROVIDERS) {
    localStorage.setItem(`permissionMode-${provider}-session`, 'default');
    view.rerender({ selectedSession: { id: `${provider}-session`, __provider: provider } });
    await waitFor(() => assert.equal(view.result.current.provider, provider));
    assert.equal(view.result.current.permissionMode, 'bypassPermissions');
    assert.deepEqual(view.result.current.availablePermissionModes, ['bypassPermissions']);
  }
});
