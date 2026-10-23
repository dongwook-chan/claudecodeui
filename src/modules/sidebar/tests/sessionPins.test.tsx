import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem, SessionRowActions, SidebarProjectListProps } from '@/shared/types';
import { SessionPinsProvider } from '@/modules/sidebar/SessionPinsProvider';
import { useSessionPins } from '@/modules/sidebar/hooks/useSessionPins';
import SidebarContent from '@/modules/sidebar/SidebarContent';
import SidebarRecentConversations from '@/modules/sidebar/SidebarRecentConversations';

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), compact: false,
}));
vi.mock('@/shared/api', () => ({
  api: { pinnedSessions: mocks.load, setSessionPinned: mocks.save },
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(['claude', 'codex']),
}));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => mocks.compact }));
vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));

const t = ((key: string, fallback?: string | { defaultValue?: string }) =>
  typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key) as TFunction;
const noop = () => {};
const EMPTY_PROJECTS: Project[] = [];
const NOW = new Date('2026-10-23T12:00:00Z');
const conversation = (sessionId: string): RecentConversationListItem => ({
  sessionId, provider: 'codex', projectId: 'project-1', projectDisplayName: 'Project one',
  sessionTitle: `Title ${sessionId}`, lastActivity: '2026-10-23T11:00:00Z',
});
const A = conversation('a'), B = conversation('b');
const PROJECTS: Project[] = [{
  projectId: 'project-1', fullPath: '/workspace/one', displayName: 'Project one',
  sessions: [{ id: 'a', summary: A.sessionTitle, __provider: 'codex' }, { id: 'b', summary: B.sessionTitle, __provider: 'codex' }],
  sessionMeta: { total: 2, hasMore: false },
}];
const actions: SessionRowActions = {
  activeRename: null, activeSessions: new Set(), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
  onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
  onSaveEditingSession: noop, onDeleteSession: noop,
};
const listProps: SidebarProjectListProps = {
  ...actions, projects: PROJECTS, filteredProjects: PROJECTS, selectedProject: null, selectedSession: null,
  isLoading: false, loadingProgress: null, isProjectExpanded: () => true,
  initialSessionsLoaded: new Set(['project-1']), currentTime: NOW, deletingProjects: new Set(),
  tasksEnabled: false, mcpServerStatus: {}, getProjectSessions: (project) => (project.sessions ?? []).map((session) => ({ ...session, __provider: session.__provider ?? 'codex' })),
  onLoadMoreSessions: noop, loadingMoreProjects: new Set(), isProjectStarred: () => false,
  onToggleProject: noop, onProjectSelect: noop, onToggleStarProject: noop,
  onStartEditingProject: noop, onCancelEditingProject: noop, onSaveProjectName: noop, onDeleteProject: noop,
  onSessionSelect: noop, onNewSession: noop, sessionSelection: null, onSetSessionSelection: noop,
  onToggleSessionSelected: noop, onCancelSessionSelection: noop, onDeleteSelectedSessions: noop, t,
};
const contentProps = (mode: 'projects' | 'conversations'): ComponentProps<typeof SidebarContent> => ({
  isPWA: false, isMobile: false, isLoading: false, projects: PROJECTS, runningSessionsCount: 0,
  archivedProjects: [], archivedSessions: [], archivedSessionsCount: 0, isArchivedSessionsLoading: false,
  recentConversations: [A, B], recentConversationsTotal: 2, recentConversationsHasMore: false,
  isRecentConversationsLoading: false, isLoadingMoreRecentConversations: false, recentConversationsError: false,
  searchFilter: '', onSearchFilterChange: noop, onClearSearchFilter: noop, searchMode: mode,
  onSearchModeChange: noop, conversationResults: null, isSearching: false, searchProgress: null,
  onRestoreArchivedProject: noop, onLoadMoreRecentConversations: noop, onRetryRecentConversations: noop,
  onArchivedSessionClick: noop, onRestoreArchivedSession: noop, onDeleteArchivedSession: noop,
  onConversationResultClick: noop, onRefresh: noop, isRefreshing: false, onCreateProject: noop,
  onCollapseSidebar: noop, updateAvailable: false, restartRequired: false, releaseInfo: null,
  latestVersion: null, currentVersion: '1.37.4', onShowVersionModal: noop, onShowSettings: noop,
  projectListProps: listProps, t,
});
const response = (sessions: RecentConversationListItem[]) => ({ ok: true, json: async () => ({ data: { sessions } }) });
const wrapper = ({ children }: { children: ReactNode }) => <SessionPinsProvider projects={EMPTY_PROJECTS}>{children}</SessionPinsProvider>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.compact = false;
  mocks.load.mockReset().mockResolvedValue(response([A]));
  mocks.save.mockReset().mockResolvedValue(response([]));
});

test('the same pinned section precedes both views; Projects keeps the original row and Conversations has no duplicate', async () => {
  const { container, rerender } = render(
    <SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('projects')} /></SessionPinsProvider>,
  );
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  const pinned = screen.getByTestId('pinned-sessions-section');
  assert.ok(within(pinned).getByText('Title a'));
  assert.ok(within(pinned).getByText('Project one'));
  assert.equal(screen.getAllByText('Title a').length, 2, 'project keeps the original session and its tree context');
  const original = screen.getAllByText('Title a')[1];
  assert.ok(pinned.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING);

  rerender(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('conversations')} /></SessionPinsProvider>);
  assert.equal(screen.getAllByText('Title a').length, 1);
  assert.ok(within(screen.getByTestId('recent-conversations-list')).getByText('Title b'));
  assert.ok(container.querySelector('[data-testid="pinned-sessions-section"]'));
});

test('unpin uses the server response in both views and returns the session to the recent feed', async () => {
  const { rerender } = render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('conversations')} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  fireEvent.click(within(screen.getByTestId('pinned-sessions-section')).getByRole('button', { name: 'Unpin session: Title a' }));
  await waitFor(() => assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false));
  assert.deepEqual(mocks.save.mock.calls, [['a', false]]);
  assert.ok(within(screen.getByTestId('recent-conversations-list')).getByText('Title a'));
  rerender(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('projects')} /></SessionPinsProvider>);
  assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false);
});

test('renaming a pinned shortcut opens just one editor even while its original project row is visible', async () => {
  function RenameHarness() {
    const [activeRename, setActiveRename] = useState<SessionRowActions['activeRename']>(null);
    const props = contentProps('projects');
    props.projectListProps = {
      ...listProps, activeRename,
      onStartEditingSession: (projectId, id, draft) => setActiveRename({ target: 'session', projectId, id, draft }),
    };
    return <SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} /></SessionPinsProvider>;
  }
  render(<RenameHarness />);
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  const pinned = screen.getByTestId('pinned-sessions-section');
  fireEvent.click(within(pinned).getByRole('button', { name: 'Session options for Title a' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename session' }));
  assert.equal(screen.getAllByRole('textbox').length, 1);
  assert.ok(within(pinned).getByRole('textbox'));
});

test('mobile project pin is reachable directly and does not select the session', async () => {
  mocks.compact = true;
  const select = vi.fn();
  const props = contentProps('projects');
  props.projectListProps = { ...listProps, onSessionSelect: select };
  mocks.load.mockResolvedValue(response([]));
  mocks.save.mockResolvedValue(response([B]));
  render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} /></SessionPinsProvider>);
  const button = screen.getByRole('button', { name: 'Pin session: Title b' });
  await waitFor(() => assert.equal(button.hasAttribute('disabled'), false));
  fireEvent.click(button);
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  assert.equal(select.mock.calls.length, 0);
  assert.deepEqual(mocks.save.mock.calls, [['b', true]]);
});

test('search and archived views do not show unrelated pinned shortcuts', async () => {
  const props = contentProps('conversations');
  const { rerender } = render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} searchFilter="x" /></SessionPinsProvider>);
  await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Unpin session: Title a' }).hasAttribute('disabled'), false));
  assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false);
  assert.ok(screen.getByText('Title a'), 'a one-character query must not hide pins when recents is still visible');
  rerender(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} searchMode="archived" /></SessionPinsProvider>);
  assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false);
});

test('pins outside the loaded recent page still render; loading older conversations keeps its pagination callback', async () => {
  const props = contentProps('conversations');
  props.recentConversations = [B];
  props.recentConversationsHasMore = true;
  const more = vi.fn();
  props.onLoadMoreRecentConversations = more;
  render(<SessionPinsProvider projects={EMPTY_PROJECTS}><SidebarContent {...props} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  assert.ok(screen.getByText('Title a'));
  fireEvent.click(screen.getByRole('button', { name: 'Load older conversations' }));
  assert.equal(more.mock.calls.length, 1);
});

test('an older in-flight refresh cannot reinsert a session after unpin', async () => {
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.ready, true));
  const stale = deferred<ReturnType<typeof response>>();
  mocks.load.mockReturnValueOnce(stale.promise);
  let oldRead!: Promise<void>;
  act(() => { oldRead = result.current!.refresh(); });
  await act(async () => { await result.current!.setPinned('a', false); });
  await act(async () => { stale.resolve(response([A])); await oldRead; });
  assert.deepEqual(result.current?.sessions, []);
});

test('a failed save keeps the original pin and exposes a retryable error', async () => {
  vi.spyOn(console, 'error').mockImplementation(noop);
  mocks.save.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.ready, true));
  await act(async () => { await result.current!.setPinned('a', false); });
  assert.equal(result.current?.pinnedIds.has('a'), true);
  assert.equal(result.current?.hasError, true);
  assert.equal(result.current?.pendingSessionId, null);
  await act(async () => { await result.current!.refresh(); });
  assert.equal(result.current?.hasError, false);
});

test('a failed initial load shows a retry control even with no pinned sessions', async () => {
  vi.spyOn(console, 'error').mockImplementation(noop);
  mocks.load.mockRejectedValueOnce(new Error('offline'));
  render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('projects')} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByRole('alert')));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => assert.equal(Boolean(screen.queryByRole('alert')), false));
  assert.ok(screen.getByTestId('pinned-sessions-section'));
});

test('double taps serialize mutations and a focus refresh picks up another device\'s pins', async () => {
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.ready, true));
  const save = deferred<ReturnType<typeof response>>();
  mocks.save.mockReturnValueOnce(save.promise);
  let first!: Promise<void>;
  act(() => { first = result.current!.setPinned('a', false); void result.current!.setPinned('a', false); });
  assert.equal(mocks.save.mock.calls.length, 1);
  assert.equal(result.current?.pendingSessionId, 'a');
  await act(async () => { save.resolve(response([])); await first; });
  mocks.load.mockResolvedValue(response([B]));
  fireEvent(window, new Event('focus'));
  await waitFor(() => assert.deepEqual(result.current?.sessions, [B]));
});

test('standalone recent rows retain their existing controls without a pin provider', () => {
  render(<SidebarRecentConversations conversations={[A]} total={1} hasMore={false} isLoading={false}
    isLoadingMore={false} hasError={false} selectedSession={null} currentTime={NOW} sessionActions={actions}
    onConversationSelect={noop} onLoadMore={noop} onRetry={noop} t={t} />);
  assert.ok(screen.getByText('Title a'));
  assert.equal(Boolean(screen.queryByRole('button', { name: 'Pin session: Title a' })), false);
});
