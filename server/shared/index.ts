// Providers shares auth/version contracts and configured CLI probes through this barrel.
export type { CliVersionProbe, ProviderAuthStatus } from './types.js';
export type { IProvider, IProviderAuth } from './interfaces.js';
export { probeCliVersion, resolveConfiguredCliExecutable, runProviderCliCommand, IS_PLATFORM, stripAnsiSequences } from './utils.js';

export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { createCompleteMessage, createNormalizedMessage } from './utils.js';
export type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderNotificationTarget } from './types.js';
export { getLinuxFileLockIdentity, parseLinuxExclusiveFileLocks } from './utils.js';
// Sessions and WebSocket use these shared transport and history contracts.
export type { BackgroundTaskSummary, FetchHistoryOptions, FetchHistoryResult, LLMProvider, NormalizedMessage, WorkflowAgentActivity, AuthenticatedWebSocketRequest, ProviderPermissionDecision } from './types.js';
export type { ChatAttachmentDescriptor } from './image-attachments.js';
export { AppError, sliceTailPage, parseIncomingJsonObject } from './utils.js';
export { getGlobalImageAssetsDir, isImageAttachmentDescriptor, normalizeAttachmentDescriptors } from './image-attachments.js';
// Provider synchronizers use these shared filesystem and transcript metadata helpers.
export { buildLookupMap, extractFirstValidJsonlData, findFilesRecursivelyModifiedAfter, normalizeSessionName, readFileTimestamps, readObjectRecord, readOptionalString } from './utils.js';
export type { IProviderSessionSynchronizer } from './interfaces.js';
