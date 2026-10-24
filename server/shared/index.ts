// Providers shares auth/version contracts and configured CLI probes through this barrel.
export type { CliVersionProbe, ProviderAuthStatus } from './types.js';
export type { IProvider, IProviderAuth } from './interfaces.js';
export { probeCliVersion, resolveConfiguredCliExecutable, runProviderCliCommand, IS_PLATFORM, stripAnsiSequences } from './utils.js';

export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { createCompleteMessage, createNormalizedMessage } from './utils.js';
export type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderNotificationTarget } from './types.js';
