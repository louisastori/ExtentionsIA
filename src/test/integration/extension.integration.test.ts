import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigurationService } from '../../core/config/configurationService';
import type { AgentLoopPolicy, AgentRunSnapshot } from '../../core/types';
import { WorkspaceService } from '../../core/workspace/workspaceService';
import type { ExtensionApi } from '../../extension';

const liveAgentEnvFlag = 'ESCTENTIONIALOCAL_LIVE_AGENT_E2E';
const liveAgentModelEnvFlag = 'ESCTENTIONIALOCAL_LIVE_AGENT_MODEL';
const liveAgentProfileId = 'ollama-live-agent-e2e';

suite('Extension Integration', () => {
  test('extension manifest is visible in the VS Code test host', () => {
    const extension = vscode.extensions.getExtension('local-dev.esctentionialocal');
    assert.ok(extension, 'Extension should be registered in the test host');
    assert.equal(extension?.id, 'local-dev.esctentionialocal');
  });

  test('workspace service reads files inside the opened workspace', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0, 'A workspace folder should be open for integration tests');

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const workspaceService = new WorkspaceService();
    const targetFile = path.join(workspaceRoot, 'src', 'extension.ts');
    const file = await workspaceService.readFile(targetFile);

    assert.equal(file.absolutePath, path.resolve(targetFile));
    assert.equal(file.workspacePath, path.join('src', 'extension.ts'));
    assert.ok(file.content.includes('export function activate'));
    assert.ok(file.lineCount > 0);
  });

  test('workspace service searches the current workspace', async () => {
    const workspaceService = new WorkspaceService();
    const result = await workspaceService.searchWorkspace('esctentionialocal.setProviderApiKey', 20);

    assert.ok(result.totalMatches > 0);
    assert.ok(result.matches.every((match) => match.workspacePath.length > 0));
    assert.ok(result.matches.some((match) => match.absolutePath.endsWith(path.join('src', 'extension.ts'))));
  });

  test('configuration defaults are exposed through VS Code settings', () => {
    const configurationService = new ConfigurationService();
    const providers = configurationService.getProvidersConfig();

    assert.equal(configurationService.getDefaultMode(), 'chat');
    assert.equal(configurationService.isLocalOnlyMode(), true);
    assert.ok(providers.profiles.length > 0);
    assert.equal(providers.activeProfileId, 'ollama-gemma4-26b-local');
    assert.equal(configurationService.getDefaultTemperature(), 1);
    assert.ok(providers.profiles.every((profile) => profile.providerType === 'ollama' || profile.providerType === 'openai-compatible'));
  });

  test('live agent creates a small HTML page through the extension runtime', async function () {
    this.timeout(420_000);

    if (process.env[liveAgentEnvFlag] !== '1') {
      this.skip();
      return;
    }

    const model = process.env[liveAgentModelEnvFlag] ?? 'devstral-small-2:latest';
    const canRun = await canRunLiveOllamaTest(model);
    if (!canRun) {
      this.skip();
      return;
    }

    const extension = vscode.extensions.getExtension<ExtensionApi>('local-dev.esctentionialocal');
    assert.ok(extension, 'Extension should be registered in the test host');

    const api = await extension.activate();
    const restoreConfiguration = await configureLiveAgentProfile(model);
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'A workspace folder should be open for integration tests');

      const outputWorkspacePath = '.tmp/integration-live-agent/mini-site.html';
      const outputAbsolutePath = path.join(workspaceFolder.uri.fsPath, ...outputWorkspacePath.split('/'));
      await deleteIfExists(outputAbsolutePath);

      const goal = [
        `Create a complete responsive HTML landing page in ${outputWorkspacePath}.`,
        'Use create_file and write the full file content.',
        'The page must contain the exact heading text "E2E Live Test" and a CTA button labeled "Launch".',
        'Do not use terminal commands.',
        'Finish by calling complete_task.'
      ].join(' ');

      const finalStatus = await runLiveAgent(api, goal, model);

      assert.equal(finalStatus.status, 'completed', finalStatus.stopReason ?? finalStatus.summary ?? 'Agent did not complete');
      assert.ok(finalStatus.toolCallsUsed > 0, 'The live agent should use at least one tool call');

      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(outputAbsolutePath));
      const content = Buffer.from(bytes).toString('utf8');

      assert.match(content, /<!doctype html>/i);
      assert.match(content, /E2E Live Test/);
      assert.match(content, /Launch/);
      assert.match(content, /<button/i);
      assert.match(content, /<style/i);
    } finally {
      await restoreConfiguration();
    }
  });
});

async function canRunLiveOllamaTest(model: string): Promise<boolean> {
  try {
    const versionResponse = await fetch('http://localhost:11434/api/version');
    if (!versionResponse.ok) {
      return false;
    }

    const tagsResponse = await fetch('http://localhost:11434/api/tags');
    if (!tagsResponse.ok) {
      return false;
    }

    const tags = (await tagsResponse.json()) as { models?: Array<{ name?: string }> };
    return tags.models?.some((entry) => entry.name === model) ?? false;
  } catch {
    return false;
  }
}

async function configureLiveAgentProfile(model: string): Promise<() => Promise<void>> {
  const configuration = vscode.workspace.getConfiguration('esctentionialocal');
  const target = vscode.ConfigurationTarget.Workspace;
  const previousProviders = configuration.inspect('providers')?.workspaceValue;
  const previousDefaultProfileId = configuration.inspect('defaultProfileId')?.workspaceValue;
  const previousDefaultModel = configuration.inspect('defaultModel')?.workspaceValue;
  const previousLocalOnlyMode = configuration.inspect('localOnlyMode')?.workspaceValue;

  await Promise.all([
    configuration.update(
      'providers',
      {
        version: 1,
        activeProfileId: liveAgentProfileId,
        profiles: [
          {
            id: liveAgentProfileId,
            label: 'Ollama Live Agent E2E',
            providerType: 'ollama',
            baseUrl: 'http://localhost:11434',
            model,
            temperature: 0.1,
            maxOutputTokens: 4096,
            capabilities: {
              streaming: true,
              toolCalling: true,
              jsonMode: false,
              vision: false,
              reasoningEffort: false
            }
          }
        ]
      },
      target
    ),
    configuration.update('defaultProfileId', liveAgentProfileId, target),
    configuration.update('defaultModel', model, target),
    configuration.update('localOnlyMode', true, target)
  ]);

  return async () => {
    await Promise.all([
      configuration.update('providers', previousProviders, target),
      configuration.update('defaultProfileId', previousDefaultProfileId, target),
      configuration.update('defaultModel', previousDefaultModel, target),
      configuration.update('localOnlyMode', previousLocalOnlyMode, target)
    ]);
  };
}

async function runLiveAgent(api: ExtensionApi, goal: string, model: string): Promise<AgentRunSnapshot> {
  const policy: AgentLoopPolicy = {
    maxIterations: 4,
    maxToolCalls: 6,
    timeBudgetMs: 300_000,
    maxConsecutiveFailures: 2,
    autoApproveReadOnlyTools: true,
    autoApproveWorkspaceEdits: true,
    autoApproveTerminal: false,
    commandAllowList: [],
    commandDenyList: ['rm -rf /', 'git reset --hard', 'del /s /q']
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const handle = api.agentOrchestrator.startRun({
      profileId: liveAgentProfileId,
      model,
      goal,
      policy,
      onStatus: (snapshot) => {
        if (settled) {
          return;
        }

        if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
          settled = true;
          clearTimeout(timeout);
          resolve(snapshot);
        }
      },
      onApprovalRequired: async (approval) => {
        return approval.toolName === 'execute_terminal_command' ? 'rejected' : 'approved';
      }
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      handle.cancel();
      reject(new Error('Timed out waiting for the live agent integration test to finish.'));
    }, policy.timeBudgetMs + 30_000);
  });
}

async function deleteIfExists(absolutePath: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath), {
      recursive: true,
      useTrash: false
    });
  } catch {
    // ignore missing path
  }
}
