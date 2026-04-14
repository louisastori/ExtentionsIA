import type {
  ProviderExecutionContext,
  ProviderEvent,
  ProviderToolExecutionContext,
  ProviderToolTurn,
  ProviderType
} from '../types';

export interface LlmProviderAdapter {
  readonly providerType: ProviderType;
  createChatCompletion(request: ProviderExecutionContext): AsyncIterable<ProviderEvent>;
  createAgentTurn?(request: ProviderToolExecutionContext): Promise<ProviderToolTurn>;
}
