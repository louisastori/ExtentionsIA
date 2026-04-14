import { joinUrl, requestJson } from '../httpClient';
import type { LlmProviderAdapter } from '../types';
import type {
  CanonicalAgentMessage,
  ProviderEvent,
  ProviderExecutionContext,
  ProviderToolExecutionContext,
  ProviderToolTurn
} from '../../types';

interface OllamaResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{
      type?: string;
      function?: {
        index?: number;
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
    }>;
  };
}

const OLLAMA_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class OllamaAdapter implements LlmProviderAdapter {
  public readonly providerType = 'ollama' as const;

  public async *createChatCompletion(request: ProviderExecutionContext): AsyncIterable<ProviderEvent> {
    const endpoint = joinUrl(request.profile.baseUrl ?? 'http://localhost:11434', '/api/chat');
    const response = await requestJson<OllamaResponse>(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.profile.customHeaders
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        stream: false,
        options: {
          temperature: request.profile.temperature,
          top_p: request.profile.topP,
          num_predict: request.profile.maxOutputTokens
        }
      }),
      timeoutMs: OLLAMA_REQUEST_TIMEOUT_MS,
      signal: request.signal
    });

    const text = response.body.message?.content?.trim() ?? '';
    if (text.length > 0) {
      yield {
        type: 'text-delta',
        text
      };
    }

    yield { type: 'done' };
  }

  public async createAgentTurn(request: ProviderToolExecutionContext): Promise<ProviderToolTurn> {
    const endpoint = joinUrl(request.profile.baseUrl ?? 'http://localhost:11434', '/api/chat');
    const response = await requestJson<OllamaResponse>(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.profile.customHeaders
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => toOllamaMessage(message)),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        })),
        stream: false,
        options: {
          temperature: request.profile.temperature,
          top_p: request.profile.topP,
          num_predict: request.profile.maxOutputTokens
        }
      }),
      timeoutMs: OLLAMA_REQUEST_TIMEOUT_MS,
      signal: request.signal
    });

    return {
      text: response.body.message?.content?.trim() ?? '',
      toolCalls:
        response.body.message?.tool_calls?.map((toolCall, index) => ({
          id: `ollama-tool-${index}-${Math.random().toString(36).slice(2, 8)}`,
          name: toolCall.function?.name ?? 'unknown_tool',
          arguments: safeParseArguments(toolCall.function?.arguments)
        })) ?? [],
      finishReason: response.body.message?.tool_calls?.length ? 'tool_calls' : 'stop'
    };
  }
}

function toOllamaMessage(message: CanonicalAgentMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_name: message.name,
      content: message.content
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall, index) => ({
        type: 'function',
        function: {
          index,
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }))
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function safeParseArguments(value: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
