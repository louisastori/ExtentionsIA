import assert from 'node:assert/strict';
import { SessionStore } from '../core/session/sessionStore';
import type {
  ActiveEditorContext,
  GpuGuardSnapshot,
  PersistedSessionState,
  ProjectMemorySnapshot,
  QueuedPromptPreview,
  ResolvedProviderProfile,
  TerminalPolicySnapshot
} from '../core/types';
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

const activeEditorContext: ActiveEditorContext = {
  absolutePath: 'C:/workspace/src/extension.ts',
  workspacePath: 'src/extension.ts',
  languageId: 'typescript',
  isDirty: false,
  lineCount: 120,
  cursorLine: 24,
  cursorCharacter: 7,
  focusStartLine: 24,
  focusEndLine: 24,
  excerptStartLine: 12,
  excerptEndLine: 36,
  excerpt: '  24 | vscode.commands.registerCommand(...)'
};

const projectMemory: ProjectMemorySnapshot = {
  fingerprint: 'workspace-fingerprint',
  displayName: 'esctentionIALocal',
  workspaceFolders: ['workspace'],
  description: 'Extension VS Code orientee agent de code.',
  techStack: ['React', 'TypeScript', 'VS Code extension'],
  packageScripts: ['compile', 'lint', 'test:unit'],
  importantFiles: ['package.json', 'README.md', 'src/extension.ts'],
  updatedAt: '2026-04-14T00:00:00.000Z'
};

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
        queuedPrompts,
        activeEditorContext
      );

      assert.equal(snapshot.queuedPrompts.length, 2);
      assert.deepEqual(snapshot.queuedPrompts, queuedPrompts);
      assert.equal(snapshot.activeEditorContext?.workspacePath, 'src/extension.ts');
      assert.equal(snapshot.isBusy, false);
    }
  },
  {
    name: 'session store tracks task history and injects memory into prompts',
    async run() {
      const store = new SessionStore('chat', 'ollama-local', 'qwen3');
      store.setProjectMemory(projectMemory);

      store.startRun({
        runId: 'run-1',
        mode: 'agent',
        profileId: 'ollama-local',
        profileLabel: 'Ollama Local',
        model: 'qwen3',
        userText: 'Cree une application pour bloquer une touche du clavier.'
      });
      store.appendAssistantDelta('run-1', 'Application de blocage des touches creee.');
      store.completeRun('run-1', 'Application de blocage des touches creee.');

      const conversation = store.buildConversation('system prompt');
      const snapshot = store.createSnapshot(profiles, ['C:/workspace'], terminalPolicy, gpuGuard, undefined, undefined);

      assert.equal(snapshot.taskHistory.length, 1);
      assert.equal(snapshot.taskHistory[0]?.status, 'completed');
      assert.equal(snapshot.taskHistory[0]?.summary, 'Application de blocage des touches creee.');
      assert.equal(snapshot.projectMemory?.displayName, 'esctentionIALocal');
      assert.match(conversation[0]?.content ?? '', /Memoire persistante du workspace/);
      assert.match(conversation[0]?.content ?? '', /Profil projet courant/);
      assert.match(conversation[0]?.content ?? '', /Extension VS Code orientee agent de code/);
      assert.match(conversation[0]?.content ?? '', /blocage des touches creee/i);
    }
  },
  {
    name: 'session store injects project memory without previous task history',
    async run() {
      const store = new SessionStore('chat', 'ollama-local', 'qwen3');
      store.setProjectMemory(projectMemory);

      const conversation = store.buildConversation('system prompt');
      const persisted = store.exportPersistedState();

      assert.match(conversation[0]?.content ?? '', /Ne redemande pas a quoi correspond le projet/);
      assert.match(conversation[0]?.content ?? '', /esctentionIALocal/);
      assert.equal(persisted.projectMemory?.displayName, 'esctentionIALocal');
    }
  },
  {
    name: 'session store injects active editor context into prompts',
    async run() {
      const store = new SessionStore('chat', 'ollama-local', 'qwen3');
      const conversation = store.buildConversation(
        'system prompt',
        undefined,
        'Contexte automatique de l editeur actif dans VS Code.\n- Fichier actif: src/extension.ts'
      );

      assert.match(conversation[0]?.content ?? '', /Contexte automatique de l editeur actif/);
      assert.match(conversation[0]?.content ?? '', /src\/extension\.ts/);
    }
  },
  {
    name: 'restored persisted session marks interrupted work as cancelled',
    async run() {
      const persisted: PersistedSessionState = {
        version: 1,
        sessionId: 'session-restored',
        mode: 'agent',
        activeProfileId: 'ollama-local',
        selectedModel: 'qwen3',
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: '',
            createdAt: '2026-04-14T00:00:00.000Z',
            runId: 'run-1',
            status: 'streaming'
          }
        ],
        commandHistory: [
          {
            runId: 'cmd-1',
            command: 'npm test',
            cwd: 'C:/workspace',
            status: 'running',
            startedAt: '2026-04-14T00:00:00.000Z',
            stdout: '',
            stderr: ''
          }
        ],
        taskHistory: [
          {
            id: 'task-1',
            runId: 'run-1',
            mode: 'agent',
            userText: 'Termine la correction en cours.',
            summary: '',
            createdAt: '2026-04-14T00:00:00.000Z',
            updatedAt: '2026-04-14T00:00:00.000Z',
            status: 'running'
          }
        ]
      };

      const store = new SessionStore('chat', 'ollama-local', 'qwen3', persisted);
      const snapshot = store.createSnapshot(profiles, ['C:/workspace'], terminalPolicy, gpuGuard, undefined, undefined);

      assert.equal(snapshot.isBusy, false);
      assert.equal(snapshot.messages[0]?.status, 'error');
      assert.equal(snapshot.commandHistory[0]?.status, 'cancelled');
      assert.equal(snapshot.taskHistory[0]?.status, 'cancelled');
    }
  }
];
