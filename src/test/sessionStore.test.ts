import assert from 'node:assert/strict';
import { SessionStore } from '../core/session/sessionStore';
import type { GpuGuardSnapshot, QueuedPromptPreview, ResolvedProviderProfile, TerminalPolicySnapshot } from '../core/types';
import type { TestCase } from './toolRuntime.test';

const terminalPolicy: TerminalPolicySnapshot = {
  autoApproveWorkspaceEdits: false,
  autoApproveTerminal: false,
  commandAllowList: [],
  commandDenyList: []
};

const gpuGuard: GpuGuardSnapshot = {
  policy: {
    enabled: false,
    provider: 'off',
    pollIntervalMs: 5000,
    action: 'pause'
  },
  status: 'disabled',
  provider: 'off',
  devices: [],
  limitExceeded: false,
  reasons: []
};

const profiles: ResolvedProviderProfile[] = [
  {
    id: 'ollama-local',
    label: 'Ollama Local',
    providerType: 'ollama',
    model: 'qwen3',
    hasApiKey: false,
    isLocal: true
  }
];

export const sessionStoreTests: TestCase[] = [
  {
    name: 'session snapshot exposes queued prompt previews',
    async run() {
      const store = new SessionStore('chat', 'ollama-local', 'qwen3');
      const queuedPrompts: QueuedPromptPreview[] = [
        {
          id: 'queued-1',
          mode: 'chat',
          textPreview: 'Explique le fichier suivant',
          createdAt: '2026-04-14T00:00:00.000Z'
        },
        {
          id: 'queued-2',
          mode: 'agent',
          textPreview: 'Applique la correction ensuite',
          createdAt: '2026-04-14T00:00:01.000Z'
        }
      ];

      const snapshot = store.createSnapshot(
        profiles,
        ['C:/workspace'],
        terminalPolicy,
        gpuGuard,
        undefined,
        'system prompt',
        undefined,
        queuedPrompts
      );

      assert.equal(snapshot.queuedPrompts.length, 2);
      assert.deepEqual(snapshot.queuedPrompts, queuedPrompts);
      assert.equal(snapshot.isBusy, false);
    }
  }
];
