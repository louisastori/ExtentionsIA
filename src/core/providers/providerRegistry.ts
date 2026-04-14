import { ConfigurationService } from '../config/configurationService';
import { isLocalProfile } from '../config/profileUtils';
import { SecretStorageService } from '../config/secretStorageService';
import type {
  CanonicalChatMessage,
  ProviderEvent,
  ProviderProfile,
  ProviderToolTurn,
  ProviderType,
  ResolvedProviderProfile
} from '../types';
import { AnthropicAdapter } from './adapters/anthropicAdapter';
import { GoogleAdapter } from './adapters/googleAdapter';
import { OllamaAdapter } from './adapters/ollamaAdapter';
import { OpenAiAdapter } from './adapters/openAIAdapter';
import { OpenAiCompatibleAdapter } from './adapters/openAICompatibleAdapter';
import type { LlmProviderAdapter } from './types';

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderType, LlmProviderAdapter>();

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly secretStorage: SecretStorageService
  ) {
    this.adapters.set('openai', new OpenAiAdapter());
    this.adapters.set('openai-compatible', new OpenAiCompatibleAdapter());
    this.adapters.set('anthropic', new AnthropicAdapter());
    this.adapters.set('google', new GoogleAdapter());
    this.adapters.set('ollama', new OllamaAdapter());
  }

  public getActiveProfileId(): string {
    return this.configurationService.getProvidersConfig().activeProfileId ?? '';
  }

  public getProfile(profileId: string): ProviderProfile | undefined {
    return this.configurationService
      .getProvidersConfig()
      .profiles.find((profile) => profile.id === profileId);
  }

  public async getResolvedProfiles(): Promise<ResolvedProviderProfile[]> {
    const profiles = this.configurationService.getProvidersConfig().profiles;
    return Promise.all(
      profiles.map(async (profile) => ({
        ...profile,
        hasApiKey: profile.apiKeySecretRef ? await this.secretStorage.hasSecret(profile.apiKeySecretRef) : true,
        isLocal: isLocalProfile(profile)
      }))
    );
  }

  public async createChatCompletion(request: {
    profileId: string;
    model?: string;
    messages: CanonicalChatMessage[];
    signal?: AbortSignal;
  }): Promise<AsyncIterable<ProviderEvent>> {
    const profile = this.getProfile(request.profileId);
    if (!profile) {
      throw new Error(`Unknown provider profile "${request.profileId}".`);
    }

    const adapter = this.adapters.get(profile.providerType);
    if (!adapter) {
      throw new Error(`No adapter registered for provider type "${profile.providerType}".`);
    }

    const apiKey = profile.apiKeySecretRef
      ? await this.secretStorage.getSecret(profile.apiKeySecretRef)
      : undefined;

    if (requiresApiKey(profile) && !apiKey) {
      throw new Error(
        `No API key configured for profile "${profile.label}". Use the command "Set esctentionIALocal Provider API Key".`
      );
    }

    return adapter.createChatCompletion({
      profile,
      model: request.model?.trim() || profile.model,
      apiKey,
      messages: request.messages,
      signal: request.signal
    });
  }

  public async createAgentTurn(request: {
    profileId: string;
    model?: string;
    messages: import('../types').CanonicalAgentMessage[];
    tools: import('../types').CanonicalToolDefinition[];
    signal?: AbortSignal;
  }): Promise<ProviderToolTurn> {
    const profile = this.getProfile(request.profileId);
    if (!profile) {
      throw new Error(`Unknown provider profile "${request.profileId}".`);
    }

    const adapter = this.adapters.get(profile.providerType);
    if (!adapter?.createAgentTurn) {
      throw new Error(`Provider "${profile.label}" does not support canonical tool calling yet.`);
    }

    const apiKey = profile.apiKeySecretRef
      ? await this.secretStorage.getSecret(profile.apiKeySecretRef)
      : undefined;

    if (requiresApiKey(profile) && !apiKey) {
      throw new Error(
        `No API key configured for profile "${profile.label}". Use the command "Set esctentionIALocal Provider API Key".`
      );
    }

    return adapter.createAgentTurn({
      profile,
      model: request.model?.trim() || profile.model,
      apiKey,
      messages: request.messages,
      tools: request.tools,
      signal: request.signal
    });
  }
}

function requiresApiKey(profile: ProviderProfile): boolean {
  return (
    profile.providerType === 'openai' ||
    profile.providerType === 'anthropic' ||
    profile.providerType === 'google'
  );
}
