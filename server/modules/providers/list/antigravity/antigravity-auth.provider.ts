import type { CliVersionProbe, IProviderAuth, ProviderAuthStatus } from '@/shared/index.js';
import { probeCliVersion, resolveConfiguredCliExecutable, runProviderCliCommand } from '@/shared/index.js';

const antigravityExecutable = () =>
  resolveConfiguredCliExecutable(process.env.AGY_CLI_PATH, 'agy');

/** Antigravity installation and authentication probe used by provider routes. */
export class AntigravityProviderAuth implements IProviderAuth {
  /** Provider status and CLI settings use the configured AGY executable's version. */
  checkInstalled(): CliVersionProbe {
    const probe = probeCliVersion(antigravityExecutable());
    return { ...probe, installed: probe.installed && probe.exitCode === 0 };
  }

  /** Reports installation and login state through lightweight AGY probes. */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    if (!installed) {
      return {
        installed: false,
        installedVersion,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI is not installed',
      };
    }

    const modelsResult = await runProviderCliCommand(antigravityExecutable(), ['models'], {
      timeoutMs: 10_000,
    });
    const authenticated = !modelsResult.error && modelsResult.exitCode === 0;

    return {
      installed,
      installedVersion,
      provider: 'antigravity',
      authenticated,
      email: authenticated ? 'Authenticated' : null,
      method: authenticated ? 'agy' : null,
      error: authenticated ? undefined : 'Antigravity CLI is not authenticated',
    };
  }
}
