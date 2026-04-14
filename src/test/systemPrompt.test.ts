import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../core/chat/systemPrompt';
import type { TestCase } from './toolRuntime.test';

export const systemPromptTests: TestCase[] = [
  {
    name: 'chat system prompt defaults to french responses',
    async run() {
      const prompt = buildSystemPrompt('chat');

      assert.match(prompt, /Reponds toujours en francais/);
      assert.match(prompt, /Mode demande par l utilisateur: chat\./);
    }
  },
  {
    name: 'system prompt appends override',
    async run() {
      const prompt = buildSystemPrompt('chat', 'Toujours verifier git status.');

      assert.match(prompt, /Toujours verifier git status\./);
    }
  }
];
