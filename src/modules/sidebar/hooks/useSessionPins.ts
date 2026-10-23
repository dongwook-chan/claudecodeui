import { createContext, useContext } from 'react';

import type { RecentConversationListItem } from '@/shared/types';

export type SessionPinsState = {
  sessions: RecentConversationListItem[];
  pinnedIds: ReadonlySet<string>;
  ready: boolean;
  hasError: boolean;
  pendingSessionId: string | null;
  refresh: () => Promise<void>;
  setPinned: (sessionId: string, isPinned: boolean) => Promise<void>;
};

export const SessionPinsContext = createContext<SessionPinsState | null>(null);

/** Pin buttons and both sidebar lists consume the same canonical state; isolated row callers may omit the provider. */
export function useSessionPins() {
  return useContext(SessionPinsContext);
}
