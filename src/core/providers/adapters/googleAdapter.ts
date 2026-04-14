import { requestJson } from '../httpClient';
import type { LlmProviderAdapter } from '../types';
import type {
  CanonicalAgentMessage,
  CanonicalToolCall,
  ProviderEvent,
  ProviderExecutionContext,
  ProviderToolExecutionContext,
  ProviderToolTurn
} from '../../types';

interface GoogleGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: GooglePart[];
    };
    finishReason?: string;
  }>;
}

interface GooglePart {
  text?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: Record<string, unknown>;
  };
}

interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

export class GoogleAdapter implements LlmProviderAdapter {
  public readonly providerType = 'google' as const;

  public async *createChatCompletion(request: ProviderExecutionContext): AsyncIterable<ProviderEvent> {
    if (!request.apiKey) {
      throw new Error('Google provider requires an API key.');
    }

    const baseUrl = request.profile.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const endpoint = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(
      request.model
    )}:generateContent?key=${encodeURIComponent(request.apiKey)}`;

    const systemMessage = request.messages.find((message) => message.role === 'system')?.content;
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [
          {
            text: message.content
          }
        ]
      }));

    const response = await requestJson<GoogleGenerateContentResponse>(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.profile.customHeaders
      },
      body: JSON.stringify({
        systemInstruction: systemMessage
          ? {
              parts: [
                {
                  text: systemMessage
                }
              ]
            }
          : undefined,
        contents,
        generationConfig: {
          temperature: request.profile.temperature,
          topP: request.profile.topP,
          maxOutputTokens: request.profile.maxOutputTokens
        }
      }),
      signal: request.signal
    });

    const text = (response.body.candidates?.[0]?.content?.parts ?? [])
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
    if (!request.apiKey) {
      throw new Error('Google provider requires an API key.');
    }

    const baseUrl = request.profile.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const endpoint = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(
      request.model
    )}:generateContent?key=${encodeURIComponent(request.apiKey)}`;
    const systemMessage = request.messages.find((message) => message.role === 'system')?.content;

    const response = await requestJson<GoogleGenerateContentResponse>(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': request.apiKey,
        ...request.profile.customHeaders
      },
      body: JSON.stringify({
        systemInstruction: systemMessage
          ? {
              parts: [
                {
                  text: systemMessage
                }
              ]
            }
          : undefined,
        contents: toGoogleContents(request.messages),
        tools: [
          {
            functionDeclarations: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }))
          }
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: 'AUTO'
          }
        },
        generationConfig: {
          temperature: request.profile.temperature,
          topP: request.profile.topP,
          maxOutputTokens: request.profile.maxOutputTokens
        }
      }),
      signal: request.signal
    });

    const candidate = response.body.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    return {
      text: parts
        .map((part) => part.text ?? '')
        .join('')
        .trim(),
      toolCalls: parts
        .filter((part) => part.functionCall)
        .map((part) => ({
          id: part.functionCall?.id ?? `gemini-tool-${Math.random().toString(36).slice(2, 10)}`,
          name: part.functionCall?.name ?? 'unknown_tool',
          arguments: part.functionCall?.args ?? {}
        })),
      finishReason: candidate?.finishReason
    };
  }
}

function toGoogleContents(messages: CanonicalAgentMessage[]): GoogleContent[] {
  const contents: GoogleContent[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }

    if (isGoogleUserMessage(message)) {
      if (message.content.length === 0) {
        continue;
      }

      contents.push({
        role: 'user',
        parts: [
          {
            text: message.content
          }
        ]
      });
      continue;
    }

    if (isGoogleAssistantMessage(message)) {
      const parts: GooglePart[] = [];

      if (message.content.length > 0) {
        parts.push({
          text: message.content
        });
      }

      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.arguments
          }
        });
      }

      if (parts.length === 0) {
        continue;
      }

      contents.push({
        role: 'model',
        parts
      });
      continue;
    }

    if (!isGoogleToolMessage(message)) {
      continue;
    }

    const responsePart: GooglePart = {
      functionResponse: {
        id: message.toolCallId,
        name: message.name,
        response: buildGoogleFunctionResponse(message)
      }
    };

    const previous = contents[contents.length - 1];
    if (previous?.role === 'user' && previous.parts.every((part) => Boolean(part.functionResponse))) {
      previous.parts.push(responsePart);
      continue;
    }

    contents.push({
      role: 'user',
      parts: [responsePart]
    });
  }

  return contents;
}

function buildGoogleFunctionResponse(message: GoogleToolMessage): Record<string, unknown> {
  return {
    result: safeParseJson(message.content) ?? message.content,
    isError: message.isError ?? false
  };
}

function safeParseJson(value: string): Record<string, unknown> | string | null {
  try {
    return JSON.parse(value) as Record<string, unknown> | string;
  } catch {
    return null;
  }
}

type GoogleAssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls?: CanonicalToolCall[];
};

type GoogleUserMessage = {
  role: 'user';
  content: string;
};

type GoogleToolMessage = {
  role: 'tool';
  name: string;
  toolCallId: string;
  content: string;
  isError?: boolean;
};

function isGoogleAssistantMessage(message: CanonicalAgentMessage): message is GoogleAssistantMessage {
  return message.role === 'assistant';
}

function isGoogleUserMessage(message: CanonicalAgentMessage): message is GoogleUserMessage {
  return message.role === 'user';
}

function isGoogleToolMessage(message: CanonicalAgentMessage): message is GoogleToolMessage {
  return message.role === 'tool';
}
