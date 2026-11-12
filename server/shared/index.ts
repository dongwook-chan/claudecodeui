// Providers shares auth/version contracts and configured CLI probes through this barrel.
export type { CliVersionProbe, ProviderAuthStatus } from './types.js';
export type { IProvider, IProviderAuth } from './interfaces.js';
export { probeCliVersion, resolveConfiguredCliExecutable, runProviderCliCommand, IS_PLATFORM, stripAnsiSequences } from './utils.js';

export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { createCompleteMessage, createNormalizedMessage } from './utils.js';
export type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderNotificationTarget } from './types.js';
// WebSocket and Providers expose explicit launch settings for deployment recovery.
export type { RealtimeClientConnection, SessionResumeOptions } from './types.js';
export { getLinuxFileLockIdentity, parseLinuxExclusiveFileLocks } from './utils.js';
// Sessions and WebSocket use these shared transport and history contracts.
export type { BackgroundTaskSummary, FetchHistoryOptions, FetchHistoryResult, LLMProvider, NormalizedMessage, WorkflowAgentActivity, AuthenticatedWebSocketRequest, ProviderPermissionDecision } from './types.js';
export type { ChatAttachmentDescriptor } from './image-attachments.js';
export { AppError, sliceTailPage, parseIncomingJsonObject } from './utils.js';
export { getGlobalImageAssetsDir, isImageAttachmentDescriptor, normalizeAttachmentDescriptors } from './image-attachments.js';

// WebSocket validates the same side-question ids as the providers dismiss route.
export { SIDE_QUESTION_ID_PATTERN } from './utils.js';
// Provider synchronizers use these shared filesystem and transcript metadata helpers.
export { buildLookupMap, extractFirstValidJsonlData, findFilesRecursivelyModifiedAfter, normalizeSessionName, readFileTimestamps, readObjectRecord, readOptionalString } from './utils.js';
export type { IProviderSessionSynchronizer } from './interfaces.js';
// Database and Providers share the persisted session-pin summary contract.
export type { SessionPinRecord } from './types.js';
// Providers maps sanitized AgentX queue status to app-session activity.
export type { AgentxQueuedSession } from './types.js';
// Providers and Database share the bounded failure evidence contract.
export type { SessionRuntimeFailure } from './types.js';
// Providers routes validate model, MCP and skill payloads through the shared contract.
export type { CustomProviderModelEffort, CustomProviderModelInput, McpScope, McpTransport, ProviderSkillCreateFile, ProviderSkillCreateInput, UpsertProviderMcpServerInput } from './types.js';
export { asyncHandler, createApiSuccessResponse } from './utils.js';
// Providers converts native Codex rollouts into transcript rows and tool details.
export { parseFilesInputTag, toImageAttachments } from './image-attachments.js';
export { prepareTranscriptMessages } from './message-unification.js';
export { generateMessageId, truncateSubagentActivity } from './utils.js';
export type { IProviderSessions } from './interfaces.js';
export type { MemoryCitation, SubagentActivity, SubagentInfo } from './types.js';

// Provider runtimes share read-only side-question transport contracts.
export type { SideQuestion, SideQuestionEvent, SideQuestionRuntime, SideQuestionOutcome, SideQuestionRequest, SideQuestionSink } from './types.js';

// Antigravity adapters share the provider composition and native transcript contracts.
export type { IProviderFork, IProviderModels, IProviderRuntime, IProviderSkills } from './interfaces.js';
export type { ProviderModelsDefinition, ProviderModelOption, ProviderCurrentActiveModel, ProviderMcpServer, ProviderSkillSource } from './types.js';
export { buildProviderCliEnv, buildDefaultProviderCurrentActiveModel, normalizeProjectPath, normalizeAntigravityTokenUsage, readProtobufFields, readJsonConfig, readStringArray, readStringRecord, sanitizeLeafDirectoryName, stripAntigravityTags, writeJsonConfig } from './utils.js';
export { appendImagesInputTag, parseImagesInputTag } from './image-attachments.js';
export { SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS, SIDE_CONVERSATION_BOUNDARY_PROMPT } from './utils.js';
export type { ChatTurnDispatchResult } from './types.js';
