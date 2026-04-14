import type { ProvidersConfig } from '../types';

export const defaultProvidersConfig: ProvidersConfig = {
  version: 1,
  activeProfileId: 'ollama-local',
  profiles: [
    {
      id: 'ollama-local',
      label: 'Ollama Devstral Small 2',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'devstral-small-2:latest',
      temperature: 1,
      maxOutputTokens: 8192,
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: false,
        vision: true,
        reasoningEffort: false
      }
    },
    {
      id: 'ollama-devstral-2-max-local',
      label: 'Ollama Devstral 2 123B',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'devstral-2:123b',
      temperature: 1,
      maxOutputTokens: 8192,
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: false,
        vision: false,
        reasoningEffort: false
      }
    },
    {
      id: 'ollama-qwen-coder-32b-local',
      label: 'Ollama Qwen2.5 Coder 32B',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:32b',
      temperature: 1,
      maxOutputTokens: 8192,
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: false,
        vision: false,
        reasoningEffort: false
      }
    },
    {
      id: 'lmstudio-local',
      label: 'LM Studio Local',
      providerType: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      model: 'local-model',
      temperature: 1,
      maxOutputTokens: 8192,
      capabilities: {
        streaming: false,
        toolCalling: false,
        jsonMode: true,
        vision: false,
        reasoningEffort: false
      }
    }
  ]
};
