// Providers shares auth/version contracts and configured CLI probes through this barrel.
export type { CliVersionProbe, ProviderAuthStatus } from './types.js';
export type { IProvider, IProviderAuth } from './interfaces.js';
export { probeCliVersion, resolveConfiguredCliExecutable, runProviderCliCommand, IS_PLATFORM, isNewerVersion, isReleaseVersion, stripAnsiSequences } from './utils.js';

export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { createCompleteMessage, createNormalizedMessage } from './utils.js';
export type { AnyRecord, ProviderNotificationTarget, ProviderRuntimeContext, ProviderRuntimeWriter } from './types.js';

// Database and Providers share the persisted session-pin summary contract.
export type { SessionPinRecord } from './types.js';
// Providers uses these shared request payloads, validators and response helpers.
export type { CustomProviderModelEffort, CustomProviderModelInput, LLMProvider, McpScope, McpTransport, ProviderSkillCreateFile, ProviderSkillCreateInput, UpsertProviderMcpServerInput } from './types.js';
export { AppError, asyncHandler, createApiSuccessResponse, SIDE_QUESTION_ID_PATTERN } from './utils.js';

// Providers uses the shared history and runtime summary contracts through this barrel.
export type { AuthenticatedWebSocketRequest, BackgroundTaskSummary, ClearedContextSegment, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage, ProviderPermissionDecision, WorkflowAgentActivity } from './types.js';
export { parseIncomingJsonObject, sliceTailPage } from './utils.js';

// Session persistence uses canonical path normalization and fork/history metadata.
export { normalizeProjectPath } from './utils.js';
export type { SessionForkAncestor } from './types.js';

// External session detection uses these helpers to identify live CLI locks.
export { getLinuxFileLockIdentity, parseLinuxExclusiveFileLocks } from './utils.js';
// WebSocket and provider runtimes share normalized attachment descriptors.
export type { ChatAttachmentDescriptor } from './image-attachments.js';
export { getGlobalImageAssetsDir, isImageAttachmentDescriptor, normalizeAttachmentDescriptors } from './image-attachments.js';
// Provider synchronizers use these shared filesystem and transcript metadata helpers.
export { buildLookupMap, extractFirstValidJsonlData, findFilesRecursivelyModifiedAfter, normalizeSessionName, readFileTimestamps, readObjectRecord, readOptionalString } from './utils.js';
export type { IProviderSessionSynchronizer } from './interfaces.js';
