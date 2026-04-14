import { joinUrl, requestJson } from '../httpClient';
import type { LlmProviderAdapter } from '../types';
import type {
  CanonicalAgentMessage,
  ProviderEvent,
  ProviderExecutionContext,
  ProviderToolExecutionContext,
  ProviderToolTurn
} from '../../types';

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
}

export class OpenAiCompatibleAdapter implements LlmProviderAdapter {
  public readonly providerType = 'openai-compatible' as const;

  public async *createChatCompletion(
    request: ProviderExecutionContext
  ): AsyncIterable<ProviderEvent> {
    const endpoint = joinUrl(request.profile.baseUrl ?? 'http://localhost:1234/v1', '/chat/completions');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...request.profile.customHeaders
    };

    if (request.apiKey) {
      headers.authorization = `Bearer ${request.apiKey}`;
    }

    const response = await requestJson<OpenAiChatCompletionResponse>(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        temperature: request.profile.temperature,
        top_p: request.profile.topP,
        max_tokens: request.profile.maxOutputTokens
      }),
      signal: request.signal
    });

    const content = extractOpenAiContent(response.body);
    if (content.length > 0) {
      yield {
        type: 'text-delta',
        text: content
      };
    }

    yield { type: 'done' };
  }

  public async createAgentTurn(request: ProviderToolExecutionContext): Promise<ProviderToolTurn> {
    const endpoint = joinUrl(request.profile.baseUrl ?? 'http://localhost:1234/v1', '/chat/completions');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...request.profile.customHeaders
    };

    if (request.apiKey) {
      headers.authorization = `Bearer ${request.apiKey}`;
    }

    const response = await requestJson<OpenAiChatCompletionResponse>(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => toOpenAiMessage(message)),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        })),
        tool_choice: 'auto',
        temperature: request.profile.temperature,
        top_p: request.profile.topP,
        max_tokens: request.profile.maxOutputTokens
      }),
      signal: request.signal
    });

    const choice = response.body.choices?.[0];
    const toolCalls =
      choice?.message?.tool_calls?.map((toolCall) => ({
        id: toolCall.id ?? `tool-${Math.random().toString(36).slice(2, 10)}`,
        name: toolCall.function?.name ?? 'unknown_tool',
        arguments: safeParseArguments(toolCall.function?.arguments)
      })) ?? [];

    return {
      text: extractOpenAiContent(response.body),
      toolCalls,
      finishReason: choice?.finish_reason
    };
  }
}

export function extractOpenAiContent(response: OpenAiChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text ?? '')
      .join('')
      .trim();
  }

  return '';
}

function toOpenAiMessage(message: CanonicalAgentMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      }))
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function safeParseArguments(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
