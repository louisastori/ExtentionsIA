import { createId } from '../protocol/messages';
import type {
  AgentToolApprovalRequest,
  AgentRunSnapshot,
  AppMode,
  CanonicalChatMessage,
  CommandApprovalRequest,
  CommandRunRecord,
  GpuGuardSnapshot,
  ResolvedProviderProfile,
  SessionSnapshot,
  TerminalPolicySnapshot,
  TranscriptMessage
} from '../types';

export class SessionStore {
  private readonly sessionId = createId('session');
  private readonly messages: TranscriptMessage[] = [];
  private readonly commandHistory: CommandRunRecord[] = [];
  private activeProfileId: string;
  private selectedModel: string;
  private mode: AppMode;
  private busyRunId?: string;
  private pendingCommandApproval?: CommandApprovalRequest;
  private pendingAgentToolApproval?: AgentToolApprovalRequest;

  public constructor(initialMode: AppMode, initialProfileId: string, initialModel: string) {
    this.mode = initialMode;
    this.activeProfileId = initialProfileId;
    this.selectedModel = initialModel;
  }

  public hydrateSelection(mode: AppMode, profileId: string, model: string): void {
    this.mode = mode;
    this.activeProfileId = profileId;
    this.selectedModel = model;
  }

  public startRun(input: {
    runId: string;
    mode: AppMode;
    profileId: string;
    profileLabel: string;
    model: string;
    userText: string;
  }): void {
    this.mode = input.mode;
    this.activeProfileId = input.profileId;
    this.selectedModel = input.model;
    this.busyRunId = input.runId;

    this.messages.push({
      id: createId('msg'),
      role: 'user',
      content: input.userText,
      createdAt: new Date().toISOString(),
      runId: input.runId,
      status: 'complete'
    });

    this.messages.push({
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      runId: input.runId,
      profileId: input.profileId,
      profileLabel: input.profileLabel,
      model: input.model,
      status: 'streaming'
    });
  }

  public appendAssistantDelta(runId: string, textDelta: string): void {
    const message = this.findRunAssistantMessage(runId);
    if (!message) {
      return;
    }

    message.content += textDelta;
  }

  public completeRun(runId: string): void {
    const message = this.findRunAssistantMessage(runId);
    if (message) {
      message.status = 'complete';
    }

    if (this.busyRunId === runId) {
      this.busyRunId = undefined;
    }
  }

  public failRun(runId: string, errorMessage: string): void {
    const message = this.findRunAssistantMessage(runId);
    if (message) {
      if (message.content.trim().length === 0) {
        message.content = errorMessage;
      }

      message.status = 'error';
    }

    if (this.busyRunId === runId) {
      this.busyRunId = undefined;
    }
  }

  public getBusyRunId(): string | undefined {
    return this.busyRunId;
  }

  public setPendingCommandApproval(approval: CommandApprovalRequest): void {
    this.pendingCommandApproval = approval;
    this.upsertCommandRun({
      runId: approval.approvalId,
      command: approval.command,
      cwd: approval.cwd,
      label: approval.label,
      status: 'pending_approval',
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: ''
    });
  }

  public clearPendingCommandApproval(approvalId?: string): void {
    if (!approvalId || this.pendingCommandApproval?.approvalId === approvalId) {
      this.pendingCommandApproval = undefined;
    }
  }

  public getPendingCommandApproval(approvalId: string): CommandApprovalRequest | undefined {
    if (this.pendingCommandApproval?.approvalId === approvalId) {
      return this.pendingCommandApproval;
    }

    return undefined;
  }

  public setPendingAgentToolApproval(approval: AgentToolApprovalRequest): void {
    this.pendingAgentToolApproval = approval;
  }

  public getPendingAgentToolApproval(approvalId: string): AgentToolApprovalRequest | undefined {
    if (this.pendingAgentToolApproval?.approvalId === approvalId) {
      return this.pendingAgentToolApproval;
    }

    return undefined;
  }

  public clearPendingAgentToolApproval(approvalId?: string): void {
    if (!approvalId || this.pendingAgentToolApproval?.approvalId === approvalId) {
      this.pendingAgentToolApproval = undefined;
    }
  }

  public upsertCommandRun(run: CommandRunRecord): void {
    const index = this.commandHistory.findIndex((entry) => entry.runId === run.runId);
    if (index === -1) {
      this.commandHistory.unshift(run);
      return;
    }

    this.commandHistory[index] = run;
  }

  public appendCommandOutput(runId: string, stream: 'stdout' | 'stderr', textDelta: string): void {
    const record = this.commandHistory.find((entry) => entry.runId === runId);
    if (!record) {
      return;
    }

    const cappedValue = capOutput(`${record[stream]}${textDelta}`);
    record[stream] = cappedValue;
  }

  public getCommandRun(runId: string): CommandRunRecord | undefined {
    return this.commandHistory.find((entry) => entry.runId === runId);
  }

  public finalizeCommandRun(
    runId: string,
    input: Pick<CommandRunRecord, 'status' | 'endedAt' | 'exitCode'> & Partial<Pick<CommandRunRecord, 'stdout' | 'stderr'>>
  ): CommandRunRecord | undefined {
    const record = this.commandHistory.find((entry) => entry.runId === runId);
    if (!record) {
      return undefined;
    }

    record.status = input.status;
    record.endedAt = input.endedAt;
    record.exitCode = input.exitCode;
    if (input.stdout !== undefined) {
      record.stdout = capOutput(input.stdout);
    }
    if (input.stderr !== undefined) {
      record.stderr = capOutput(input.stderr);
    }

    return { ...record };
  }

  public buildConversation(systemPrompt: string): CanonicalChatMessage[] {
    const transcriptMessages = this.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .filter((message) => message.status !== 'error' || message.content.trim().length > 0)
      .map<CanonicalChatMessage>((message) => ({
        role: message.role,
        content: message.content
      }))
      .filter((message) => message.role === 'user' || message.content.trim().length > 0);

    return [
      {
        role: 'system',
        content: systemPrompt
      },
      ...transcriptMessages
    ];
  }

  public createSnapshot(
    profiles: ResolvedProviderProfile[],
    workspaceFolders: string[],
    terminalPolicy: TerminalPolicySnapshot,
    gpuGuard: GpuGuardSnapshot,
    currentAgentRun?: AgentRunSnapshot
  ): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      activeProfileId: this.activeProfileId,
      selectedModel: this.selectedModel,
      isBusy: this.busyRunId !== undefined,
      busyRunId: this.busyRunId,
      currentAgentRun,
      pendingAgentToolApproval: this.pendingAgentToolApproval,
      workspaceFolders,
      commandHistory: [...this.commandHistory],
      pendingCommandApproval: this.pendingCommandApproval,
      terminalPolicy,
      gpuGuard,
      profiles,
      messages: [...this.messages]
    };
  }

  private findRunAssistantMessage(runId: string): TranscriptMessage | undefined {
    return [...this.messages].reverse().find((message) => message.role === 'assistant' && message.runId === runId);
  }
}

function capOutput(value: string): string {
  const maxLength = 100000;
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(value.length - maxLength);
}
