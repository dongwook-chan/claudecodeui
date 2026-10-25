import assert from 'node:assert/strict';

import { render, fireEvent } from '@testing-library/react';
import { test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';

test('a queued recovery displays its position and waiting time with a Cancel action', () => {
  const abort = vi.fn();
  const { getByText, getByRole } = render(<ActivityIndicator activity={{ queued: true,
    statusText: 'Queued · #2', canInterrupt: true, startedAt: Date.now() - 310_000 }} onAbort={abort} />);
  assert.ok(getByText('Queued · #2'));
  fireEvent.click(getByRole('button', { name: 'Cancel queued retry' }));
  assert.equal(abort.mock.calls.length, 1);
});
