import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test } from 'vitest';

import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';

const t = ((key: string) => key) as unknown as TFunction;
const noop = () => {};

test('sidebar footer retains settings while omitting issue and community links', () => {
  render(
    <SidebarFooter
      updateAvailable
      restartRequired
      releaseInfo={null}
      latestVersion="1.37.6"
      currentVersion="1.37.5"
      onShowVersionModal={noop}
      onShowSettings={noop}
      t={t}
    />,
  );

  assert.equal(screen.getAllByText('actions.settings').length, 2);
  assert.equal(screen.queryByText('actions.reportIssue'), null);
  assert.equal(screen.queryByText('actions.joinCommunity'), null);
  assert.equal(screen.queryByRole('link', { name: /report|community/i }), null);
});

test('collapsed sidebar retains controls other than issue and community links', () => {
  render(
    <SidebarCollapsed
      onExpand={noop}
      onShowSettings={noop}
      updateAvailable
      restartRequired
      onShowVersionModal={noop}
      t={t}
    />,
  );

  assert.ok(screen.getByRole('button', { name: 'actions.settings' }));
  assert.equal(screen.queryByRole('link', { name: /report|community/i }), null);
  assert.equal(screen.queryByText('actions.reportIssue'), null);
  assert.equal(screen.queryByText('actions.joinCommunity'), null);
});
