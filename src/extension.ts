import * as vscode from 'vscode';
import { ChatWebviewProvider } from './chat/chatWebviewProvider';
import { AgentOrchestrator } from './core/agent/agentOrchestrator';
import { ConfigurationService } from './core/config/configurationService';
import { SecretStorageService } from './core/config/secretStorageService';
import { ProviderRegistry } from './core/providers/providerRegistry';
import { GpuGuardService } from './core/runtime/gpuGuardService';
import { SessionPersistenceService } from './core/session/sessionPersistenceService';
import { ToolRuntime } from './core/tools/toolRuntime';
import { PatchService } from './core/workspace/patchService';
import { TerminalService } from './core/workspace/terminalService';
import { WorkspaceService } from './core/workspace/workspaceService';

export interface ExtensionApi {
  configurationService: ConfigurationService;
  providerRegistry: ProviderRegistry;
  workspaceService: WorkspaceService;
  patchService: PatchService;
  terminalService: TerminalService;
  toolRuntime: ToolRuntime;
  agentOrchestrator: AgentOrchestrator;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const configurationService = new ConfigurationService();
  const secretStorage = new SecretStorageService(context.secrets);
  const providerRegistry = new ProviderRegistry(configurationService, secretStorage);
  const workspaceService = new WorkspaceService();
  const patchService = new PatchService(workspaceService);
  const terminalService = new TerminalService(workspaceService);
  const gpuGuardService = new GpuGuardService();
  const toolRuntime = new ToolRuntime(workspaceService, patchService, terminalService);
  const agentOrchestrator = new AgentOrchestrator(providerRegistry, toolRuntime);
  const sessionPersistence = new SessionPersistenceService(context.workspaceState);
  const chatWebviewProvider = new ChatWebviewProvider(
    context.extensionUri,
    configurationService,
    providerRegistry,
    workspaceService,
    patchService,
    terminalService,
    agentOrchestrator,
    gpuGuardService,
    sessionPersistence
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatWebviewProvider.viewType, chatWebviewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esctentionialocal.startAgent', async () => {
      await chatWebviewProvider.focus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esctentionialocal.setProviderApiKey', async () => {
      const profiles = (await providerRegistry.getResolvedProfiles()).filter((profile) => profile.apiKeySecretRef);
      if (profiles.length === 0) {
        const message = configurationService.isLocalOnlyMode()
          ? 'Le mode 100 % local est actif. Aucun fournisseur cloud ni aucune cle API ne sont necessaires.'
          : 'Aucun profil necessitant une cle API n’est configure.';
        void vscode.window.showInformationMessage(message);
        return;
      }

      const selectedProfile = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.label,
          description: profile.id,
          detail: profile.hasApiKey ? 'Cle API deja enregistree' : 'Aucune cle API enregistree',
          profile
        })),
        {
          placeHolder: 'Choisir le profil pour enregistrer la cle API'
        }
      );

      if (!selectedProfile?.profile.apiKeySecretRef) {
        return;
      }

      const apiKey = await vscode.window.showInputBox({
        password: true,
        ignoreFocusOut: true,
        prompt: `Cle API pour ${selectedProfile.profile.label}`
      });

      if (!apiKey) {
        return;
      }

      await secretStorage.storeSecret(selectedProfile.profile.apiKeySecretRef, apiKey);
      await configurationService.updateDefaultProfileId(selectedProfile.profile.id);
      await chatWebviewProvider.refresh();
      void vscode.window.showInformationMessage(`Cle API enregistree pour ${selectedProfile.profile.label}.`);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('esctentionialocal')) {
        await chatWebviewProvider.refresh();
      }
    })
  );

  return {
    configurationService,
    providerRegistry,
    workspaceService,
    patchService,
    terminalService,
    toolRuntime,
    agentOrchestrator
  };
}

export function deactivate(): undefined {
  return undefined;
}
