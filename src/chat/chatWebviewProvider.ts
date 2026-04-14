import { spawn } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { AgentOrchestrator, type AgentRunHandle } from '../core/agent/agentOrchestrator';
import { buildSystemPrompt } from '../core/chat/systemPrompt';
import { ConfigurationService } from '../core/config/configurationService';
import {
  createHostMessage,
  isUiAgentControlMessage,
  isUiAgentToolApprovalMessage,
  isUiChatSubmitMessage,
  isUiCommandApprovalMessage,
  isUiOllamaStartMessage,
  isUiCommandExecuteMessage,
  isUiCommandStopMessage,
  isUiGpuGuardUpdateMessage,
  isUiPatchApprovalMessage,
  isUiPatchPreviewMessage,
  isUiPreferencesSaveMessage,
  isUiReadFileMessage,
  isUiReadyMessage,
  isUiSearchWorkspaceMessage
} from '../core/protocol/messages';
import { ProviderRegistry } from '../core/providers/providerRegistry';
import { joinUrl, requestJson } from '../core/providers/httpClient';
import { GpuGuardService, createEmptyGpuGuardSnapshot } from '../core/runtime/gpuGuardService';
import { SessionStore } from '../core/session/sessionStore';
import { PatchService } from '../core/workspace/patchService';
import { TerminalService } from '../core/workspace/terminalService';
import { WorkspaceService } from '../core/workspace/workspaceService';
import type {
  AgentRunSnapshot,
  AgentToolApprovalRequest,
  AppMode,
  CommandRunRecord,
  GpuGuardPolicy,
  GpuGuardSnapshot,
  ResolvedProviderProfile,
  RunStatusPayload
} from '../core/types';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'esctentionialocal.sidebar';

  private webviewView?: vscode.WebviewView;
  private readonly sessionStore: SessionStore;
  private currentAbortController?: AbortController;
  private currentAgentHandle?: AgentRunHandle;
  private currentAgentRun?: AgentRunSnapshot;
  private currentAgentToolApproval?: AgentToolApprovalRequest;
  private currentGpuGuardState: GpuGuardSnapshot;
  private gpuMonitorTimer?: NodeJS.Timeout;
  private lastGpuGuardEnforcementKey?: string;
  private readonly pendingAgentApprovalResolvers = new Map<string, (decision: 'approved' | 'rejected') => void>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configurationService: ConfigurationService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly workspaceService: WorkspaceService,
    private readonly patchService: PatchService,
    private readonly terminalService: TerminalService,
    private readonly agentOrchestrator: AgentOrchestrator,
    private readonly gpuGuardService: GpuGuardService
  ) {
    const providersConfig = this.configurationService.getProvidersConfig();
    const fallbackProfile = providersConfig.profiles[0];
    const activeProfile =
      providersConfig.profiles.find((profile) => profile.id === providersConfig.activeProfileId) ?? fallbackProfile;

    this.sessionStore = new SessionStore(
      this.configurationService.getDefaultMode(),
      activeProfile?.id ?? 'ollama-local',
      this.configurationService.getDefaultModel(activeProfile?.model ?? 'local-model')
    );
    this.currentGpuGuardState = createEmptyGpuGuardSnapshot(this.configurationService.getGpuGuardPolicy());
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): Promise<void> {
    void context;
    void token;
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'media', 'webview')
      ]
    };
    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);
    await this.restartGpuMonitoring();
    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
      this.stopGpuMonitoring();
    });

    webviewView.webview.onDidReceiveMessage(
      async (message: unknown) => {
        if (isUiReadyMessage(message)) {
          await this.postSessionState(message.requestId);
          return;
        }

        if (isUiChatSubmitMessage(message)) {
          await this.handleChatSubmit(message);
          return;
        }

        if (isUiPreferencesSaveMessage(message)) {
          await this.handlePreferencesSave(message.requestId, message.payload);
          return;
        }

        if (isUiReadFileMessage(message)) {
          await this.handleReadFile(message.requestId, message.payload.workspacePath);
          return;
        }

        if (isUiSearchWorkspaceMessage(message)) {
          await this.handleSearchWorkspace(message.requestId, message.payload.pattern, message.payload.maxResults);
          return;
        }

        if (isUiPatchPreviewMessage(message)) {
          await this.handlePatchPreview(message.requestId, message.payload);
          return;
        }

        if (isUiPatchApprovalMessage(message)) {
          await this.handlePatchApproval(message.requestId, message.payload.proposalId, message.payload.decision);
          return;
        }

        if (isUiAgentToolApprovalMessage(message)) {
          await this.handleAgentToolApproval(message.requestId, message.payload.approvalId, message.payload.decision);
          return;
        }

        if (isUiCommandExecuteMessage(message)) {
          await this.handleCommandExecute(message.requestId, message.payload);
          return;
        }

        if (isUiCommandApprovalMessage(message)) {
          await this.handleCommandApproval(message.requestId, message.payload.approvalId, message.payload.decision);
          return;
        }

        if (isUiCommandStopMessage(message)) {
          await this.handleCommandStop(message.requestId, message.payload.runId);
          return;
        }

        if (isUiOllamaStartMessage(message)) {
          await this.handleOllamaStart(message.requestId);
          return;
        }

        if (isUiGpuGuardUpdateMessage(message)) {
          await this.handleGpuGuardUpdate(message.requestId, message.payload);
          return;
        }

        if (isUiAgentControlMessage(message)) {
          await this.handleAgentControl(message.requestId, message.type);
          return;
        }
      },
      undefined,
      []
    );
  }

  public async focus(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.esctentionialocal-sidebar-view');
    await this.postSessionState();
  }

  public async refresh(): Promise<void> {
    await this.restartGpuMonitoring();
    await this.postSessionState();
  }

  private async handleChatSubmit(message: {
    requestId: string;
    payload: { text: string; mode: AppMode; profileId?: string; model?: string };
  }): Promise<void> {
    const rawText = message.payload.text.trim();
    if (rawText.length === 0) {
      return;
    }

    if (this.sessionStore.getBusyRunId()) {
      this.postMessage(
        createHostMessage(
          'host.error',
          {
            code: 'run_in_progress',
            message: 'Une réponse est déjà en cours. Arrête-la avant de lancer une autre requête.'
          },
          message.requestId
        )
      );
      return;
    }

    const gpuRunBlockMessage = this.getGpuGuardStartBlockMessage();
    if (gpuRunBlockMessage) {
      this.postError(message.requestId, 'gpu_guard_blocked_run', gpuRunBlockMessage);
      return;
    }

    const profiles = await this.providerRegistry.getResolvedProfiles();
    const selectedProfile = resolveProfile(profiles, message.payload.profileId, this.providerRegistry.getActiveProfileId());

    if (!selectedProfile) {
      this.postMessage(
        createHostMessage(
          'host.error',
          {
            code: 'missing_profile',
            message: 'Aucun profile IA n’est configuré.'
          },
          message.requestId
        )
      );
      return;
    }

    const runId = `run-${Date.now()}`;
    const selectedModel = message.payload.model?.trim() || selectedProfile.model;

    if (message.payload.mode === 'agent') {
      await this.handleAgentSubmit(message.requestId, {
        runId,
        userText: rawText,
        selectedProfile,
        selectedModel
      });
      return;
    }

    this.sessionStore.hydrateSelection(message.payload.mode, selectedProfile.id, selectedModel);
    this.sessionStore.startRun({
      runId,
      mode: message.payload.mode,
      profileId: selectedProfile.id,
      profileLabel: selectedProfile.label,
      model: selectedModel,
      userText: rawText
    });

    this.currentAbortController = new AbortController();

    await this.postSessionState(message.requestId);
    this.postRunStatus(
      {
        runId,
        status: 'running'
      },
      message.requestId
    );

    try {
      const stream = await this.providerRegistry.createChatCompletion({
        profileId: selectedProfile.id,
        model: selectedModel,
        messages: this.sessionStore.buildConversation(buildSystemPrompt(message.payload.mode)),
        signal: this.currentAbortController.signal
      });

      for await (const event of stream) {
        if (event.type === 'text-delta' && event.text.length > 0) {
          this.sessionStore.appendAssistantDelta(runId, event.text);
          this.postMessage(
            createHostMessage(
              'host.stream.delta',
              {
                runId,
                textDelta: event.text
              },
              message.requestId
            )
          );
        }
      }

      this.sessionStore.completeRun(runId);
      this.postRunStatus(
        {
          runId,
          status: 'completed',
          stopReason: 'completed'
        },
        message.requestId
      );
    } catch (error) {
      const errorMessage = normalizeErrorMessage(error);
      const wasCancelled = errorMessage.toLowerCase().includes('aborted');

      this.sessionStore.failRun(runId, wasCancelled ? 'Réponse interrompue.' : errorMessage);
      this.postRunStatus(
        {
          runId,
          status: wasCancelled ? 'cancelled' : 'failed',
          stopReason: wasCancelled ? 'cancelled_by_user' : 'provider_error'
        },
        message.requestId
      );
      this.postMessage(
        createHostMessage(
          'host.error',
          {
            code: wasCancelled ? 'cancelled' : 'provider_error',
            message: wasCancelled ? 'Réponse interrompue.' : errorMessage,
            runId
          },
          message.requestId
        )
      );
    } finally {
      this.currentAbortController = undefined;
      await this.postSessionState(message.requestId);
    }
  }

  private async postSessionState(requestId?: string): Promise<void> {
    const profiles = await this.providerRegistry.getResolvedProfiles();
    this.postMessage(
      createHostMessage(
        'host.session.state',
        this.sessionStore.createSnapshot(
          profiles,
          this.workspaceService.getWorkspaceFolders(),
          this.configurationService.getTerminalPolicy(),
          this.currentGpuGuardState,
          this.currentAgentRun
        ),
        requestId
      )
    );
  }

  private postRunStatus(status: RunStatusPayload, requestId?: string): void {
    this.postMessage(createHostMessage('host.run.status', status, requestId));
  }

  private postMessage(message: unknown): void {
    this.webviewView?.webview.postMessage(message);
  }

  private async handleReadFile(requestId: string, workspacePath: string): Promise<void> {
    try {
      const file = await this.workspaceService.readFile(workspacePath);
      this.postMessage(createHostMessage('host.workspace.fileRead', file, requestId));
    } catch (error) {
      this.postError(requestId, 'read_file_failed', normalizeErrorMessage(error));
    }
  }

  private async handlePreferencesSave(
    requestId: string,
    payload: {
      profileId?: string;
      mode: AppMode;
      model?: string;
      autoApproveWorkspaceEdits?: boolean;
      autoApproveTerminal?: boolean;
    }
  ): Promise<void> {
    try {
      const profiles = await this.providerRegistry.getResolvedProfiles();
      const selectedProfile = resolveProfile(profiles, payload.profileId, this.providerRegistry.getActiveProfileId());
      if (!selectedProfile) {
        this.postError(requestId, 'missing_profile', 'Aucun profile IA n est configure.');
        return;
      }

      const selectedModel = payload.model?.trim() || selectedProfile.model;
      await this.configurationService.updateSavedSelection({
        profileId: selectedProfile.id,
        mode: payload.mode,
        model: selectedModel,
        autoApproveWorkspaceEdits: payload.autoApproveWorkspaceEdits,
        autoApproveTerminal: payload.autoApproveTerminal
      });

      this.sessionStore.hydrateSelection(payload.mode, selectedProfile.id, selectedModel);
      await this.postSessionState(requestId);
      this.postMessage(
        createHostMessage(
          'host.preferences.saved',
          {
            message: 'Fournisseur, mode, modele et politiques d approbation sauvegardes.'
          },
          requestId
        )
      );
    } catch (error) {
      this.postError(requestId, 'preferences_save_failed', normalizeErrorMessage(error));
    }
  }

  private async handleSearchWorkspace(requestId: string, pattern: string, maxResults?: number): Promise<void> {
    try {
      const result = await this.workspaceService.searchWorkspace(pattern, maxResults);
      this.postMessage(createHostMessage('host.workspace.searchResults', result, requestId));
    } catch (error) {
      this.postError(requestId, 'workspace_search_failed', normalizeErrorMessage(error));
    }
  }

  private async handlePatchPreview(
    requestId: string,
    payload: {
      workspacePath: string;
      searchBlock: string;
      replaceBlock: string;
      occurrence?: number;
    }
  ): Promise<void> {
    try {
      const proposal = await this.patchService.previewPatch(payload);
      this.postMessage(createHostMessage('host.patch.proposed', proposal, requestId));
    } catch (error) {
      this.postError(requestId, 'patch_preview_failed', normalizeErrorMessage(error));
    }
  }

  private async handlePatchApproval(
    requestId: string,
    proposalId: string,
    decision: 'approved' | 'rejected'
  ): Promise<void> {
    try {
      const result = await this.patchService.resolveApproval(proposalId, decision);
      this.postMessage(createHostMessage('host.patch.result', result, requestId));

      if (result.updatedFile) {
        this.postMessage(createHostMessage('host.workspace.fileRead', result.updatedFile, requestId));
      }
    } catch (error) {
      this.postError(requestId, 'patch_apply_failed', normalizeErrorMessage(error));
    }
  }

  private postError(requestId: string, code: string, message: string): void {
    this.postMessage(
      createHostMessage(
        'host.error',
        {
          code,
          message
        },
        requestId
      )
    );
  }

  private async handleAgentSubmit(
    requestId: string,
    input: {
      runId: string;
      userText: string;
      selectedProfile: ResolvedProviderProfile;
      selectedModel: string;
    }
  ): Promise<void> {
    if (this.currentAgentHandle) {
      this.postError(requestId, 'agent_already_running', 'Une execution agent est deja en cours.');
      return;
    }

    this.sessionStore.hydrateSelection('agent', input.selectedProfile.id, input.selectedModel);
    this.sessionStore.startRun({
      runId: input.runId,
      mode: 'agent',
      profileId: input.selectedProfile.id,
      profileLabel: input.selectedProfile.label,
      model: input.selectedModel,
      userText: input.userText
    });
    this.currentAbortController = new AbortController();
    await this.postSessionState(requestId);

    let finalized = false;
    this.currentAgentHandle = this.agentOrchestrator.startRun({
      profileId: input.selectedProfile.id,
      model: input.selectedModel,
      goal: input.userText,
      policy: this.configurationService.getAgentLoopPolicy(),
      signal: this.currentAbortController.signal,
      onStatus: (snapshot) => {
        this.currentAgentRun = snapshot;
        this.postMessage(createHostMessage('host.agent.status', snapshot, requestId));
        void this.postSessionState(requestId);

        if (!finalized && isAgentTerminal(snapshot.status)) {
          finalized = true;
          const finalText = snapshot.summary?.trim() || snapshot.lastAssistantText?.trim() || snapshot.stopReason || '';
          if (finalText.length > 0) {
            this.sessionStore.appendAssistantDelta(input.runId, finalText);
          }

          if (snapshot.status === 'completed') {
            this.sessionStore.completeRun(input.runId);
          } else {
            this.sessionStore.failRun(input.runId, finalText || 'L execution agent a echoue.');
          }

          this.currentAgentHandle = undefined;
          this.currentAbortController = undefined;
          this.currentAgentToolApproval = undefined;
          this.sessionStore.clearPendingAgentToolApproval();
          void this.postSessionState(requestId);
        }
      },
      onApprovalRequired: async (approval, snapshot) => {
        this.currentAgentRun = snapshot;
        this.currentAgentToolApproval = approval;
        this.sessionStore.setPendingAgentToolApproval(approval);
        this.postMessage(createHostMessage('host.agent.approvalRequired', approval, requestId));
        await this.postSessionState(requestId);

        return new Promise<'approved' | 'rejected'>((resolve) => {
          this.pendingAgentApprovalResolvers.set(approval.approvalId, resolve);
        });
      }
    });
  }

  private async handleAgentControl(
    requestId: string,
    type: 'ui.agent.stop' | 'ui.agent.pause' | 'ui.agent.resume'
  ): Promise<void> {
    if (this.currentAgentHandle) {
      if (type === 'ui.agent.stop') {
        this.stopActiveAgent(true);
      } else if (type === 'ui.agent.pause') {
        this.currentAgentHandle.pause();
      } else if (type === 'ui.agent.resume') {
        const gpuRunBlockMessage = this.getGpuGuardStartBlockMessage();
        if (gpuRunBlockMessage) {
          this.postError(requestId, 'gpu_guard_blocked_resume', gpuRunBlockMessage);
          return;
        }

        this.currentAgentHandle.resume();
      }

      return;
    }

    if (type === 'ui.agent.stop') {
      this.clearPendingAgentApprovals();
      this.currentAbortController?.abort();
      return;
    }

    this.postError(requestId, 'agent_control_unavailable', 'Aucune execution agent active n est disponible pour ce controle.');
  }

  private async handleAgentToolApproval(
    requestId: string,
    approvalId: string,
    decision: 'approved' | 'rejected'
  ): Promise<void> {
    const approval = this.sessionStore.getPendingAgentToolApproval(approvalId);
    const resolver = this.pendingAgentApprovalResolvers.get(approvalId);
    if (!approval || !resolver) {
      this.postError(requestId, 'agent_tool_approval_missing', 'La demande d approbation de l outil agent est introuvable.');
      return;
    }

    this.pendingAgentApprovalResolvers.delete(approvalId);
    this.currentAgentToolApproval = undefined;
    this.sessionStore.clearPendingAgentToolApproval(approvalId);
    resolver(decision);
    await this.postSessionState(requestId);
  }

  private async handleCommandExecute(
    requestId: string,
    payload: {
      command: string;
      cwd?: string;
      label?: string;
    }
  ): Promise<void> {
    const gpuRunBlockMessage = this.getGpuGuardStartBlockMessage();
    if (gpuRunBlockMessage) {
      this.postError(requestId, 'gpu_guard_blocked_command', gpuRunBlockMessage);
      return;
    }

    try {
      const decision = this.terminalService.prepareCommand(payload, this.configurationService.getTerminalPolicy());
      if (decision.kind === 'approval_required' && decision.approval) {
        this.sessionStore.setPendingCommandApproval(decision.approval);
        this.postMessage(createHostMessage('host.command.proposed', decision.approval, requestId));
        await this.postSessionState(requestId);
        return;
      }

      if (decision.kind === 'start_now' && decision.run) {
        this.startCommandRun(requestId, decision.run);
      }
    } catch (error) {
      this.postError(requestId, 'command_prepare_failed', normalizeErrorMessage(error));
    }
  }

  private async handleCommandApproval(
    requestId: string,
    approvalId: string,
    decision: 'approved' | 'rejected'
  ): Promise<void> {
    const approval = this.sessionStore.getPendingCommandApproval(approvalId);
    if (!approval) {
      this.postError(requestId, 'command_approval_missing', 'La demande d approbation de la commande est introuvable.');
      return;
    }

    this.sessionStore.clearPendingCommandApproval(approvalId);

    if (decision === 'rejected') {
      const rejectedRun = this.sessionStore.finalizeCommandRun(approvalId, {
        status: 'rejected',
        endedAt: new Date().toISOString(),
        exitCode: null
      });
      if (rejectedRun) {
        this.postMessage(createHostMessage('host.command.finished', rejectedRun, requestId));
      }
      await this.postSessionState(requestId);
      return;
    }

    const gpuRunBlockMessage = this.getGpuGuardStartBlockMessage();
    if (gpuRunBlockMessage) {
      const blockedRun = this.sessionStore.finalizeCommandRun(approvalId, {
        status: 'rejected',
        endedAt: new Date().toISOString(),
        exitCode: null
      });
      if (blockedRun) {
        this.postMessage(createHostMessage('host.command.finished', blockedRun, requestId));
      }
      this.postError(requestId, 'gpu_guard_blocked_command', gpuRunBlockMessage);
      await this.postSessionState(requestId);
      return;
    }

    const run = this.terminalService.startApprovedCommand(approval);
    this.startCommandRun(requestId, run);
  }

  private async handleCommandStop(requestId: string, runId: string): Promise<void> {
    const stopped = this.terminalService.stopCommand(runId);
    if (!stopped) {
      this.postError(requestId, 'command_stop_failed', 'Aucune commande en cours n a ete trouvee pour cet identifiant.');
      return;
    }

    this.postMessage(
      createHostMessage(
        'host.error',
        {
          code: 'command_stop_requested',
          message: 'Le signal d arret a ete envoye a la commande en cours.',
          runId
        },
        requestId
      )
    );
  }

  private async handleOllamaStart(requestId: string): Promise<void> {
    try {
      const baseUrl = this.getOllamaBaseUrl();
      const alreadyRunning = await isOllamaReachable(baseUrl);
      if (!alreadyRunning) {
        await launchOllamaProcess();
        await waitForOllama(baseUrl, 15000);
      }

      this.postMessage(
        createHostMessage(
          'host.preferences.saved',
          {
            message: alreadyRunning
              ? 'Ollama est deja disponible.'
              : 'Ollama a ete demarre et repond sur le port local.'
          },
          requestId
        )
      );
    } catch (error) {
      this.postError(requestId, 'ollama_start_failed', normalizeErrorMessage(error));
    }
  }

  private startCommandRun(requestId: string, run: CommandRunRecord): void {
    this.sessionStore.upsertCommandRun(run);
    this.postMessage(createHostMessage('host.command.started', run, requestId));
    void this.postSessionState(requestId);

    this.terminalService.executeCommand(run, {
      onStream: (event) => {
        this.sessionStore.appendCommandOutput(event.runId, event.stream, event.textDelta);
        this.postMessage(createHostMessage('host.command.stream', event));
      },
      onFinish: (result) => {
        const finalized = this.sessionStore.finalizeCommandRun(result.runId, {
          status: result.status,
          endedAt: result.endedAt,
          exitCode: result.exitCode
        });

        if (finalized) {
          this.postMessage(createHostMessage('host.command.finished', finalized));
        }

        void this.postSessionState();
      }
    });
  }

  private async handleGpuGuardUpdate(requestId: string, payload: Partial<GpuGuardPolicy>): Promise<void> {
    await this.configurationService.updateGpuGuardPolicy(payload);
    await this.restartGpuMonitoring(requestId);
    await this.postSessionState(requestId);
  }

  private async restartGpuMonitoring(requestId?: string): Promise<void> {
    this.stopGpuMonitoring();
    await this.pollGpuGuard(requestId);

    const policy = this.configurationService.getGpuGuardPolicy();
    if (!this.webviewView || !policy.enabled || policy.provider === 'off') {
      return;
    }

    this.gpuMonitorTimer = setInterval(() => {
      void this.pollGpuGuard();
    }, policy.pollIntervalMs);
  }

  private stopGpuMonitoring(): void {
    if (this.gpuMonitorTimer) {
      clearInterval(this.gpuMonitorTimer);
      this.gpuMonitorTimer = undefined;
    }
  }

  private async pollGpuGuard(requestId?: string): Promise<void> {
    const previous = this.currentGpuGuardState;
    const next = await this.gpuGuardService.sample(this.configurationService.getGpuGuardPolicy());
    this.currentGpuGuardState = next;
    await this.applyGpuGuardEnforcement(next, requestId);

    if (didGpuGuardStateChange(previous, next)) {
      await this.postSessionState(requestId);
    }
  }

  private async applyGpuGuardEnforcement(current: GpuGuardSnapshot, requestId?: string): Promise<void> {
    if (!current.limitExceeded) {
      this.lastGpuGuardEnforcementKey = undefined;
      return;
    }

    const enforcementKey = `${current.policy.action}|${current.reasons.join('|')}`;
    if (this.lastGpuGuardEnforcementKey === enforcementKey) {
      return;
    }

    this.lastGpuGuardEnforcementKey = enforcementKey;
    const detail = current.reasons.join('; ');
    const effectiveRequestId = requestId ?? `gpu-${Date.now()}`;

    if (current.policy.action === 'warn') {
      this.postError(effectiveRequestId, 'gpu_guard_warning', `Avertissement de surveillance GPU : ${detail}`);
      return;
    }

    if (current.policy.action === 'pause') {
      if (this.currentAgentHandle && this.currentAgentRun?.status === 'running') {
        this.currentAgentHandle.pause();
        this.postError(effectiveRequestId, 'gpu_guard_paused_agent', `La surveillance GPU a mis l agent en pause. ${detail}`);
        return;
      }

      if (this.currentAbortController && !this.currentAgentHandle && this.sessionStore.getBusyRunId()) {
        this.currentAbortController.abort();
        this.postError(
          effectiveRequestId,
          'gpu_guard_interrupted_chat',
          `La surveillance GPU a interrompu la conversation en cours car le mode discussion ne peut pas etre mis en pause. ${detail}`
        );
        return;
      }

      this.postError(
        effectiveRequestId,
        'gpu_guard_blocking_new_runs',
        `La surveillance GPU est active. Les nouvelles executions restent bloquees jusqu a baisse de la charge. ${detail}`
      );
      return;
    }

    this.stopActiveAgent(true);
    const stoppedCommands = this.terminalService.stopAllCommands();
    if (!this.currentAgentHandle && this.currentAbortController) {
      this.currentAbortController.abort();
    }

    const commandSuffix = stoppedCommands.length > 0 ? ` Commandes arretees : ${stoppedCommands.join(', ')}.` : '';
    this.postError(effectiveRequestId, 'gpu_guard_stopped_runs', `La surveillance GPU a stoppe le travail actif. ${detail}.${commandSuffix}`);
  }

  private getGpuGuardStartBlockMessage(): string | undefined {
    if (!this.currentGpuGuardState.limitExceeded || this.currentGpuGuardState.policy.action === 'warn') {
      return undefined;
    }

    const reason = this.currentGpuGuardState.reasons.join('; ');
    return `La surveillance GPU est active. Attends la baisse de charge GPU ou assouplis les seuils. ${reason}`;
  }

  private clearPendingAgentApprovals(): void {
    this.currentAgentToolApproval = undefined;
    this.sessionStore.clearPendingAgentToolApproval();
    for (const resolver of this.pendingAgentApprovalResolvers.values()) {
      resolver('rejected');
    }
    this.pendingAgentApprovalResolvers.clear();
  }

  private stopActiveAgent(abortProviderCall: boolean): void {
    this.clearPendingAgentApprovals();
    this.currentAgentHandle?.cancel();
    if (abortProviderCall) {
      this.currentAbortController?.abort();
    }
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const builtHtmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'index.html');
    if (!fs.existsSync(builtHtmlPath.fsPath)) {
      return this.getMissingBuildHtml();
    }

    const rawHtml = fs.readFileSync(builtHtmlPath.fsPath, 'utf8');
    const rewrittenAssets = rawHtml.replace(/(src|href)="([^"]+)"/g, (_match, attribute: string, value: string) => {
      if (value.startsWith('http') || value.startsWith('data:') || value.startsWith('#')) {
        return `${attribute}="${value}"`;
      }

      const assetSegments = value.replace(/^\.\//, '').split('/').filter(Boolean);
      const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', ...assetSegments));
      return `${attribute}="${assetUri.toString()}"`;
    });

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`
    ].join('; ');

    return rewrittenAssets.replace(
      '</head>',
      `  <meta http-equiv="Content-Security-Policy" content="${csp}">\n</head>`
    );
  }

  private getMissingBuildHtml(): string {
    return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px;
      }
      code {
        font-family: var(--vscode-editor-font-family);
      }
    </style>
  </head>
  <body>
    <h2>Webview non construite</h2>
    <p>Lance <code>npm install</code> puis <code>npm run compile</code> pour générer l'interface React.</p>
  </body>
</html>`;
  }

  private getOllamaBaseUrl(): string {
    return (
      this.configurationService.getProvidersConfig().profiles.find((profile) => profile.providerType === 'ollama')?.baseUrl ??
      'http://localhost:11434'
    );
  }
}

function resolveProfile(
  profiles: ResolvedProviderProfile[],
  requestedProfileId: string | undefined,
  defaultProfileId: string
): ResolvedProviderProfile | undefined {
  return (
    profiles.find((profile) => profile.id === requestedProfileId) ??
    profiles.find((profile) => profile.id === defaultProfileId) ??
    profiles[0]
  );
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isAgentTerminal(status: AgentRunSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

async function isOllamaReachable(baseUrl: string): Promise<boolean> {
  try {
    await requestJson(joinUrl(baseUrl, '/api/version'), {
      method: 'GET',
      timeoutMs: 2000
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForOllama(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await requestJson(joinUrl(baseUrl, '/api/version'), {
        method: 'GET',
        timeoutMs: 2000
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(`Ollama n a pas repondu apres demarrage. ${normalizeErrorMessage(lastError)}`);
}

async function launchOllamaProcess(): Promise<void> {
  const candidates = [
    'ollama',
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(candidate, ['serve'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });

        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return;
    } catch (error) {
      errors.push(`${candidate}: ${normalizeErrorMessage(error)}`);
    }
  }

  throw new Error(`Impossible de lancer Ollama. ${errors.join(' | ')}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function didGpuGuardStateChange(previous: GpuGuardSnapshot | undefined, next: GpuGuardSnapshot): boolean {
  if (!previous) {
    return true;
  }

  return JSON.stringify({
    policy: previous.policy,
    status: previous.status,
    provider: previous.provider,
    devices: previous.devices,
    limitExceeded: previous.limitExceeded,
    reasons: previous.reasons,
    error: previous.error
  }) !==
    JSON.stringify({
      policy: next.policy,
      status: next.status,
      provider: next.provider,
      devices: next.devices,
      limitExceeded: next.limitExceeded,
      reasons: next.reasons,
      error: next.error
    });
}
