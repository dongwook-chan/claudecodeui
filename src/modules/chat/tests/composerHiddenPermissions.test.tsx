import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

test.each([false, true])('composer omits the permission control while retaining model and submit (loading=%s)', (isLoading) => {
  const onAbortSession = vi.fn();
  const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
  const noop = () => {};
  const props: ComponentProps<typeof ChatComposer> = {
    pendingPermissionRequests: [], handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    activity: null, isLoading, onAbortSession,
    effort: 'high', availableEffortOptions: [{ value: 'high' }], onSelectEffort: noop,
    model: 'test-model', availableModelOptions: [{ value: 'test-model', label: 'Test model' }],
    onSelectModel: noop, modelsLoading: false, tokenBudget: null, onShowTokenUsage: noop,
    slashCommandsCount: 0, onToggleCommandMenu: noop, hasInput: !isLoading, onClearInput: noop,
    onSubmit, isDragActive: false, queuedDraft: null, backgroundSendPrompt: null,
    onResolveBackgroundSendPrompt: noop, isEditingSentMessage: false, onCancelEditMessage: noop,
    scheduledMessages: [], onScheduleMessage: noop, onCancelScheduledMessage: noop,
    onEditQueuedDraft: noop, onDeleteQueuedDraft: noop, attachedFiles: [],
    onRemoveAttachment: noop, fileErrors: new Map(), showFileDropdown: false,
    filteredFiles: [], selectedFileIndex: 0, onSelectFile: noop, filteredCommands: [],
    selectedCommandIndex: 0, onCommandSelect: noop, onCloseCommandMenu: noop,
    isCommandMenuOpen: false, frequentCommands: [], getRootProps: () => ({}),
    getInputProps: () => ({}), openAttachmentPicker: noop,
    inputHighlightRef: createRef<HTMLDivElement>(), renderInputWithMentions: (text) => text,
    textareaRef: createRef<HTMLTextAreaElement>(), input: isLoading ? '' : 'hello',
    onInputChange: noop, onTextareaClick: noop, onTextareaKeyDown: noop,
    onTextareaPaste: noop, onTextareaScrollSync: noop, onTextareaInput: noop,
    placeholder: 'Message', isTextareaExpanded: false,
  };
  const { container } = render(<ChatComposer {...props} />);
  assert.equal(screen.queryByText(/Bypass Permissions|Default Mode|Accept Edits|Plan Mode/i), null);
  assert.equal(screen.queryByRole('button', { name: /permissions|permission mode/i }), null);
  assert.equal(screen.queryByRole('menuitemradio'), null);
  assert.ok(screen.getByRole('button', { name: /model and reasoning/i }));
  assert.ok(screen.getByPlaceholderText('Message'));
  if (isLoading) {
    const stop = container.querySelector('button[aria-label="Stop"]');
    assert.ok(stop);
    fireEvent.click(stop);
    assert.equal(onAbortSession.mock.calls.length, 1);
  } else {
    const submit = container.querySelector('button[type="submit"]');
    assert.ok(submit);
    fireEvent.click(submit);
    assert.equal(onSubmit.mock.calls.length, 1);
  }
});
