import type { ProviderExecutionContext, ProviderEvent, ProviderToolExecutionContext, ProviderToolTurn } from '../../types';
import type { LlmProviderAdapter } from '../types';
import { OpenAiCompatibleAdapter } from './openAICompatibleAdapter';

export class OpenAiAdapter implements LlmProviderAdapter {
  public readonly providerType = 'openai' as const;
  private readonly delegate = new OpenAiCompatibleAdapter();

  public createChatCompletion(request: ProviderExecutionContext): AsyncIterable<ProviderEvent> {
    return this.delegate.createChatCompletion({
      ...request,
      profile: {
        ...request.profile,
        baseUrl: request.profile.baseUrl ?? 'https://api.openai.com/v1'
      }
    });
  }

  public createAgentTurn(request: ProviderToolExecutionContext): Promise<ProviderToolTurn> {
    if (!this.delegate.createAgentTurn) {
      throw new Error('OpenAI-compatible agent tool calling is not available.');
    }

    return this.delegate.createAgentTurn({
      ...request,
      profile: {
        ...request.profile,
        baseUrl: request.profile.baseUrl ?? 'https://api.openai.com/v1'
      }
    });
  }
}
