import { joinUrl, requestJson } from '../httpClient';
import type { LlmProviderAdapter } from '../types';
import type {
  CanonicalAgentMessage,
  CanonicalToolCall,
  ProviderEvent,
  ProviderExecutionContext,
  ProviderToolExecutionContext,
  ProviderToolTurn
} from '../../types';

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicRequestMessage {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
}

export class AnthropicAdapter implements LlmProviderAdapter {
  public readonly providerType = 'anthropic' as const;

  public async *createChatCompletion(request: ProviderExecutionContext): AsyncIterable<ProviderEvent> {
    const endpoint = joinUrl(request.profile.baseUrl ?? 'https://api.anthropic.com', '/v1/messages');
    const systemMessage = request.messages.find((message) => message.role === 'system')?.content;
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content: [
          {
            type: 'text',
            text: message.content
          }
        ]
      }));

    const response = await requestJson<AnthropicResponse>(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': request.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        ...request.profile.customHeaders
      },
      body: JSON.stringify({
        model: request.model,
        system: systemMessage,
        messages,
        max_tokens: request.profile.maxOutputTokens ?? 4096,
        temperature: request.profile.temperature
      }),
      signal: request.signal
    });

    const text = (response.body.content ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (text.length > 0) {
      yield {
        type: 'text-delta',
        text
      };
    }

    yield { type: 'done' };
  }

  public async createAgentTurn(request: ProviderToolExecutionContext): Promise<ProviderToolTurn> {
    const endpoint = joinUrl(request.profile.baseUrl ?? 'https://api.anthropic.com', '/v1/messages');
    const systemMessage = request.messages.find((message) => message.role === 'system')?.content;

    const response = await requestJson<AnthropicResponse>(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': request.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        ...request.profile.customHeaders
      },
      body: JSON.stringify({
        model: request.model,
        system: systemMessage,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema
        })),
        max_tokens: request.profile.maxOutputTokens ?? 4096,
        temperature: request.profile.temperature
      }),
      signal: request.signal
    });

    return {
      text: extractAnthropicText(response.body),
      toolCalls:
        response.body.content
          ?.filter((part) => part.type === 'tool_use')
          .map((part) => ({
            id: part.id ?? `tool-${Math.random().toString(36).slice(2, 10)}`,
            name: part.name ?? 'unknown_tool',
            arguments: isRecord(part.input) ? part.input : {}
          })) ?? [],
      finishReason: response.body.stop_reason
    };
  }
}

function extractAnthropicText(response: AnthropicResponse): string {
  return (response.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

function toAnthropicMessages(messages: CanonicalAgentMessage[]): AnthropicRequestMessage[] {
  const results: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }

    if (isAnthropicUserMessage(message)) {
      if (message.content.length === 0) {
        continue;
      }

      results.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.content
          }
        ]
      });
      continue;
    }

    if (isAnthropicAssistantMessage(message)) {
      const content = buildAnthropicAssistantContent(message);
      if (content.length === 0) {
        continue;
      }

      results.push({
        role: 'assistant',
        content
      });
      continue;
    }

    if (!isAnthropicToolMessage(message)) {
      continue;
    }

    const toolResultBlock: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: message.content
    };

    if (message.isError) {
      toolResultBlock.is_error = true;
    }

    const previous = results[results.length - 1];
    if (previous?.role === 'user' && previous.content.every(isAnthropicToolResultBlock)) {
      previous.content.push(toolResultBlock);
      continue;
    }

    results.push({
      role: 'user',
      content: [toolResultBlock]
    });
  }

  return results;
}

function buildAnthropicAssistantContent(message: AnthropicAssistantMessage): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];

  if (message.content.length > 0) {
    content.push({
      type: 'text',
      text: message.content
    });
  }

  for (const toolCall of message.toolCalls ?? []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.arguments
    });
  }

  return content;
}

function isAnthropicToolResultBlock(block: Record<string, unknown>): boolean {
  return block.type === 'tool_result';
}

type AnthropicAssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls?: CanonicalToolCall[];
};

type AnthropicUserMessage = {
  role: 'user';
  content: string;
};

type AnthropicToolMessage = {
  role: 'tool';
  name: string;
  toolCallId: string;
  content: string;
  isError?: boolean;
};

function isAnthropicAssistantMessage(message: CanonicalAgentMessage): message is AnthropicAssistantMessage {
  return message.role === 'assistant';
}

function isAnthropicUserMessage(message: CanonicalAgentMessage): message is AnthropicUserMessage {
  return message.role === 'user';
}

function isAnthropicToolMessage(message: CanonicalAgentMessage): message is AnthropicToolMessage {
  return message.role === 'tool';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
