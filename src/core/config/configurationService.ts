import * as vscode from 'vscode';
import { defaultProvidersConfig } from './defaultProfiles';
import { isLocalProfile } from './profileUtils';
import type {
  AgentLoopPolicy,
  AppMode,
  GpuGuardAction,
  GpuGuardPolicy,
  GpuGuardProvider,
  ProviderProfile,
  ProvidersConfig,
  TerminalPolicySnapshot
} from '../types';

const EXTENSION_NAMESPACE = 'esctentionialocal';

export class ConfigurationService {
  public getDefaultMode(): AppMode {
    const mode = this.getConfiguration().get<string>('defaultMode', 'agent');
    return isAppMode(mode) ? mode : 'agent';
  }

  public getDefaultModel(fallbackModel: string): string {
    const configuredModel = this.getConfiguration().get<string>('defaultModel', '').trim();
    return configuredModel || fallbackModel;
  }

  public getDefaultTemperature(fallback?: number): number | undefined {
    const configuredTemperature = this.getConfiguration().get<number | undefined>('defaultTemperature', undefined);
    if (typeof configuredTemperature !== 'number' || !Number.isFinite(configuredTemperature)) {
      return fallback;
    }

    return Math.max(0, Math.min(2, configuredTemperature));
  }

  public getSystemPromptOverride(): string | undefined {
    const configuredPrompt = this.getConfiguration().get<string>('systemPrompt', '').trim();
    return configuredPrompt.length > 0 ? configuredPrompt : undefined;
  }

  public isLocalOnlyMode(): boolean {
    return this.getConfiguration().get<boolean>('localOnlyMode', true);
  }

  public getProvidersConfig(): ProvidersConfig {
    const configuration = this.getConfiguration();
    const rawConfig = configuration.get<Partial<ProvidersConfig>>('providers', {});
    const configuredProfiles = Array.isArray(rawConfig?.profiles)
      ? rawConfig.profiles.map((profile) => normalizeProfile(profile))
      : [];
    const preferredProfiles = configuredProfiles.length > 0 ? configuredProfiles : defaultProvidersConfig.profiles;
    const profiles = this.isLocalOnlyMode()
      ? preferredProfiles.filter((profile) => isLocalProfile(profile))
      : preferredProfiles;
    const fallbackProfiles =
      profiles.length > 0
        ? profiles
        : defaultProvidersConfig.profiles.filter((profile) => isLocalProfile(profile));
    const activeProfileId =
      configuration.get<string>('defaultProfileId') ??
      rawConfig?.activeProfileId ??
      defaultProvidersConfig.activeProfileId ??
      fallbackProfiles[0]?.id;

    const resolvedActiveProfileId =
      fallbackProfiles.find((profile) => profile.id === activeProfileId)?.id ?? fallbackProfiles[0]?.id;

    return {
      version: 1,
      activeProfileId: resolvedActiveProfileId,
      profiles: fallbackProfiles
    };
  }

  public async updateDefaultProfileId(profileId: string): Promise<void> {
    await this.getConfiguration().update('defaultProfileId', profileId, vscode.ConfigurationTarget.Global);
  }

  public async updateSavedSelection(input: {
    profileId: string;
    mode: AppMode;
    model: string;
    autoApproveWorkspaceEdits?: boolean;
    autoApproveTerminal?: boolean;
    temperature?: number;
    systemPrompt?: string;
  }): Promise<void> {
    const configuration = this.getConfiguration();
    const target = vscode.ConfigurationTarget.Global;

    const operations: Thenable<void>[] = [
      configuration.update('defaultProfileId', input.profileId, target),
      configuration.update('defaultMode', input.mode, target),
      configuration.update('defaultModel', input.model.trim(), target)
    ];

    if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
      const normalized = Math.max(0, Math.min(2, input.temperature));
      operations.push(configuration.update('defaultTemperature', normalized, target));
    }

    if (typeof input.systemPrompt === 'string') {
      operations.push(configuration.update('systemPrompt', input.systemPrompt, target));
    }

    if (typeof input.autoApproveWorkspaceEdits === 'boolean') {
      operations.push(configuration.update('agent.autoApproveWorkspaceEdits', input.autoApproveWorkspaceEdits, target));
    }

    if (typeof input.autoApproveTerminal === 'boolean') {
      operations.push(configuration.update('agent.autoApproveTerminal', input.autoApproveTerminal, target));
    }

    await Promise.all(operations);
  }

  public getTerminalPolicy(): TerminalPolicySnapshot {
    const configuration = this.getConfiguration();
    return {
      autoApproveWorkspaceEdits: configuration.get<boolean>('agent.autoApproveWorkspaceEdits', false),
      autoApproveTerminal: configuration.get<boolean>('agent.autoApproveTerminal', false),
      commandAllowList: configuration.get<string[]>('agent.commandAllowList', [
        'npm test',
        'npm run test',
        'npm run lint',
        'npm run build',
        'pnpm test',
        'pnpm lint',
        'pnpm build'
      ]),
      commandDenyList: configuration.get<string[]>('agent.commandDenyList', ['rm -rf /', 'git reset --hard', 'del /s /q'])
    };
  }

  public getAgentLoopPolicy(): AgentLoopPolicy {
    const configuration = this.getConfiguration();
    const terminalPolicy = this.getTerminalPolicy();
    return {
      maxIterations: configuration.get<number>('agent.maxIterations', 12),
      maxToolCalls: configuration.get<number>('agent.maxToolCalls', 30),
      timeBudgetMs: configuration.get<number>('agent.timeBudgetMs', 1800000),
      maxConsecutiveFailures: configuration.get<number>('agent.maxConsecutiveFailures', 3),
      autoApproveReadOnlyTools: configuration.get<boolean>('agent.autoApproveReadOnlyTools', true),
      autoApproveWorkspaceEdits: configuration.get<boolean>('agent.autoApproveWorkspaceEdits', false),
      autoApproveTerminal: configuration.get<boolean>('agent.autoApproveTerminal', false),
      commandAllowList: terminalPolicy.commandAllowList,
      commandDenyList: terminalPolicy.commandDenyList
    };
  }

  public getGpuGuardPolicy(): GpuGuardPolicy {
    const configuration = this.getConfiguration();
    const provider = configuration.get<string>('gpuGuard.provider', 'auto');
    const action = configuration.get<string>('gpuGuard.action', 'pause');

    return {
      enabled: configuration.get<boolean>('gpuGuard.enabled', false),
      provider: isGpuGuardProvider(provider) ? provider : 'auto',
      maxTemperatureC: normalizeOptionalThreshold(configuration.get<number | undefined>('gpuGuard.maxTemperatureC', 80)),
      maxUtilizationPercent: normalizeOptionalThreshold(
        configuration.get<number | undefined>('gpuGuard.maxUtilizationPercent', 90),
        1,
        100
      ),
      pollIntervalMs: normalizePollInterval(configuration.get<number>('gpuGuard.pollIntervalMs', 5000)),
      action: isGpuGuardAction(action) ? action : 'pause'
    };
  }

  public async updateGpuGuardPolicy(update: Partial<GpuGuardPolicy>): Promise<void> {
    const configuration = this.getConfiguration();
    const target = vscode.ConfigurationTarget.Global;
    const operations: Thenable<void>[] = [];

    if ('enabled' in update) {
      operations.push(configuration.update('gpuGuard.enabled', update.enabled, target));
    }
    if ('provider' in update) {
      operations.push(configuration.update('gpuGuard.provider', update.provider, target));
    }
    if ('maxTemperatureC' in update) {
      operations.push(configuration.update('gpuGuard.maxTemperatureC', update.maxTemperatureC, target));
    }
    if ('maxUtilizationPercent' in update) {
      operations.push(configuration.update('gpuGuard.maxUtilizationPercent', update.maxUtilizationPercent, target));
    }
    if ('pollIntervalMs' in update) {
      operations.push(configuration.update('gpuGuard.pollIntervalMs', update.pollIntervalMs, target));
    }
    if ('action' in update) {
      operations.push(configuration.update('gpuGuard.action', update.action, target));
    }

    await Promise.all(operations);
  }

  private getConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
  }
}

function normalizeProfile(profile: Partial<ProviderProfile>): ProviderProfile {
  return {
    id: profile.id ?? 'custom-profile',
    label: profile.label ?? profile.id ?? 'Custom profile',
    providerType: profile.providerType ?? 'openai-compatible',
    baseUrl: profile.baseUrl,
    apiKeySecretRef: profile.apiKeySecretRef,
    model: profile.model ?? 'local-model',
    fallbackModel: profile.fallbackModel,
    temperature: profile.temperature,
    topP: profile.topP,
    maxOutputTokens: profile.maxOutputTokens,
    reasoningEffort: profile.reasoningEffort,
    customHeaders: profile.customHeaders,
    capabilities: profile.capabilities
  };
}

function isAppMode(value: string): value is AppMode {
  return value === 'chat' || value === 'edit' || value === 'run' || value === 'agent';
}

function isGpuGuardProvider(value: string): value is GpuGuardProvider {
  return value === 'off' || value === 'auto' || value === 'nvidia-smi';
}

function isGpuGuardAction(value: string): value is GpuGuardAction {
  return value === 'warn' || value === 'pause' || value === 'stop';
}

function normalizeOptionalThreshold(value: number | undefined, min = 1, max = 120): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(min, Math.min(max, value));
}

function normalizePollInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 5000;
  }

  return Math.max(1000, Math.round(value));
}
