import { createId } from '../protocol/messages';
import type {
  AgentToolApprovalRequest,
  AgentRunSnapshot,
  AppMode,
  CanonicalChatMessage,
  CommandApprovalRequest,
  CommandRunRecord,
  GpuGuardSnapshot,
  PersistedSessionState,
  QueuedPromptPreview,
  ResolvedProviderProfile,
  SessionSnapshot,
  TaskHistoryEntry,
  TerminalPolicySnapshot,
  TranscriptMessage
} from '../types';

const MAX_MESSAGES = 240;
const MAX_COMMAND_HISTORY = 40;
const MAX_TASK_HISTORY = 80;
const MAX_MEMORY_TASKS = 8;
const MAX_MEMORY_COMMANDS = 4;
const MAX_MEMORY_BLOCK_LENGTH = 3200;

export class SessionStore {
  private readonly sessionId: string;
  private readonly messages: TranscriptMessage[];
  private readonly commandHistory: CommandRunRecord[];
  private readonly taskHistory: TaskHistoryEntry[];
  private activeProfileId: string;
  private selectedModel: string;
  private mode: AppMode;
  private busyRunId?: string;
  private pendingCommandApproval?: CommandApprovalRequest;
  private pendingAgentToolApproval?: AgentToolApprovalRequest;

  public constructor(
    initialMode: AppMode,
    initialProfileId: string,
    initialModel: string,
    persistedState?: PersistedSessionState
  ) {
    const restoredState = restorePersistedState(persistedState);

    this.sessionId = restoredState?.sessionId ?? createId('session');
    this.mode = restoredState?.mode ?? initialMode;
    this.activeProfileId = restoredState?.activeProfileId ?? initialProfileId;
    this.selectedModel = restoredState?.selectedModel ?? initialModel;
    this.messages = restoredState?.messages ?? [];
    this.commandHistory = restoredState?.commandHistory ?? [];
    this.taskHistory = restoredState?.taskHistory ?? [];
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
    const createdAt = new Date().toISOString();

    this.mode = input.mode;
    this.activeProfileId = input.profileId;
    this.selectedModel = input.model;
    this.busyRunId = input.runId;

    this.messages.push({
      id: createId('msg'),
      role: 'user',
      content: input.userText,
      createdAt,
      runId: input.runId,
      status: 'complete'
    });

    this.messages.push({
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt,
      runId: input.runId,
      profileId: input.profileId,
      profileLabel: input.profileLabel,
      model: input.model,
      status: 'streaming'
    });

    this.upsertTaskHistoryEntry({
      id: createId('task'),
      runId: input.runId,
      mode: input.mode,
      userText: input.userText,
      summary: '',
      createdAt,
      updatedAt: createdAt,
      profileId: input.profileId,
      profileLabel: input.profileLabel,
      model: input.model,
      status: 'running'
    });
    this.trimTranscript();
  }

  public appendAssistantDelta(runId: string, textDelta: string): void {
    const message = this.findRunAssistantMessage(runId);
    if (!message) {
      return;
    }

    message.content += textDelta;
  }

  public completeRun(runId: string, summaryOverride?: string): void {
    const message = this.findRunAssistantMessage(runId);
    if (message) {
      message.status = 'complete';
    }

    this.finalizeTaskHistory(runId, 'completed', summaryOverride ?? message?.content ?? '');

    if (this.busyRunId === runId) {
      this.busyRunId = undefined;
    }
  }

  public failRun(
    runId: string,
    errorMessage: string,
    taskStatus: 'failed' | 'cancelled' = 'failed',
    summaryOverride?: string
  ): void {
    const message = this.findRunAssistantMessage(runId);
    if (message) {
      if (message.content.trim().length === 0) {
        message.content = errorMessage;
      }

      message.status = 'error';
    }

    this.finalizeTaskHistory(runId, taskStatus, summaryOverride ?? message?.content ?? errorMessage);

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
      this.trimCommandHistory();
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

  public buildConversation(systemPrompt: string, currentRunId?: string): CanonicalChatMessage[] {
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
        content: mergeSystemPromptWithMemory(systemPrompt, this.buildMemoryContext(currentRunId))
      },
      ...transcriptMessages
    ];
  }

  public buildMemoryContext(currentRunId?: string): string | undefined {
    const recentTasks = this.taskHistory.filter((entry) => entry.runId !== currentRunId).slice(0, MAX_MEMORY_TASKS);
    const recentCommands = this.commandHistory
      .filter((entry) => entry.status !== 'pending_approval')
      .slice(0, MAX_MEMORY_COMMANDS);

    if (recentTasks.length === 0 && recentCommands.length === 0) {
      return undefined;
    }

    const sections: string[] = ['Memoire persistante du workspace. Appuie-toi sur cet historique pour savoir ce qui a deja ete fait.'];

    if (recentTasks.length > 0) {
      sections.push('Taches recentes:');
      for (const entry of recentTasks) {
        sections.push(
          `- [${formatTaskStatus(entry.status)} | ${entry.mode}] demande: ${shorten(entry.userText, 140)} | resultat: ${shorten(
            entry.summary || defaultTaskSummary(entry.status),
            180
          )}`
        );
      }
    }

    if (recentCommands.length > 0) {
      sections.push('Commandes recentes:');
      for (const entry of recentCommands) {
        sections.push(
          `- ${shorten(entry.command, 90)} | ${formatCommandStatus(entry.status)} | code ${formatExitCode(entry.exitCode)}`
        );
      }
    }

    const memoryBlock = sections.join('\n');
    if (memoryBlock.length <= MAX_MEMORY_BLOCK_LENGTH) {
      return memoryBlock;
    }

    return `${memoryBlock.slice(0, MAX_MEMORY_BLOCK_LENGTH - 3)}...`;
  }

  public exportPersistedState(): PersistedSessionState {
    return {
      version: 1,
      sessionId: this.sessionId,
      mode: this.mode,
      activeProfileId: this.activeProfileId,
      selectedModel: this.selectedModel,
      messages: [...this.messages],
      commandHistory: [...this.commandHistory],
      taskHistory: [...this.taskHistory]
    };
  }

  public createSnapshot(
    profiles: ResolvedProviderProfile[],
    workspaceFolders: string[],
    terminalPolicy: TerminalPolicySnapshot,
    gpuGuard: GpuGuardSnapshot,
    defaultTemperature: number | undefined,
    systemPrompt: string | undefined,
    currentAgentRun?: AgentRunSnapshot,
    queuedPrompts: QueuedPromptPreview[] = []
  ): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      activeProfileId: this.activeProfileId,
      selectedModel: this.selectedModel,
      defaultTemperature,
      systemPrompt,
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
      queuedPrompts: [...queuedPrompts],
      taskHistory: [...this.taskHistory],
      messages: [...this.messages]
    };
  }

  private findRunAssistantMessage(runId: string): TranscriptMessage | undefined {
    return [...this.messages].reverse().find((message) => message.role === 'assistant' && message.runId === runId);
  }

  private upsertTaskHistoryEntry(entry: TaskHistoryEntry): void {
    const index = this.taskHistory.findIndex((item) => item.runId === entry.runId);
    if (index === -1) {
      this.taskHistory.unshift(entry);
      this.trimTaskHistory();
      return;
    }

    this.taskHistory[index] = entry;
  }

  private finalizeTaskHistory(runId: string, status: TaskHistoryEntry['status'], summary: string): void {
    const entry = this.taskHistory.find((item) => item.runId === runId);
    if (!entry) {
      return;
    }

    entry.status = status;
    entry.summary = shorten(summary.trim() || defaultTaskSummary(status), 320);
    entry.updatedAt = new Date().toISOString();
  }

  private trimTranscript(): void {
    if (this.messages.length <= MAX_MESSAGES) {
      return;
    }

    this.messages.splice(0, this.messages.length - MAX_MESSAGES);
  }

  private trimCommandHistory(): void {
    if (this.commandHistory.length <= MAX_COMMAND_HISTORY) {
      return;
    }

    this.commandHistory.splice(MAX_COMMAND_HISTORY);
  }

  private trimTaskHistory(): void {
    if (this.taskHistory.length <= MAX_TASK_HISTORY) {
      return;
    }

    this.taskHistory.splice(MAX_TASK_HISTORY);
  }
}

function restorePersistedState(state: PersistedSessionState | undefined): PersistedSessionState | undefined {
  if (!state) {
    return undefined;
  }

  const recoveredAt = new Date().toISOString();

  return {
    ...state,
    messages: state.messages
      .slice(-MAX_MESSAGES)
      .map((message) =>
        message.status === 'streaming'
          ? {
              ...message,
              status: 'error',
              content: message.content.trim().length > 0 ? message.content : 'Session precedente interrompue.'
            }
          : message
      ),
    commandHistory: state.commandHistory.slice(0, MAX_COMMAND_HISTORY).map((entry) => {
      if (entry.status !== 'running' && entry.status !== 'pending_approval') {
        return entry;
      }

      return {
        ...entry,
        status: 'cancelled',
        endedAt: entry.endedAt ?? recoveredAt,
        exitCode: null
      };
    }),
    taskHistory: state.taskHistory.slice(0, MAX_TASK_HISTORY).map((entry) => {
      if (entry.status !== 'running') {
        return entry;
      }

      return {
        ...entry,
        status: 'cancelled',
        summary: entry.summary.trim() || 'Session precedente interrompue avant la fin.',
        updatedAt: recoveredAt
      };
    })
  };
}

function mergeSystemPromptWithMemory(systemPrompt: string, memoryContext: string | undefined): string {
  if (!memoryContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${memoryContext}`;
}

function capOutput(value: string): string {
  const maxLength = 100000;
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(value.length - maxLength);
}

function shorten(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatTaskStatus(status: TaskHistoryEntry['status']): string {
  switch (status) {
    case 'completed':
      return 'termine';
    case 'failed':
      return 'echoue';
    case 'cancelled':
      return 'annule';
    default:
      return 'en cours';
  }
}

function formatCommandStatus(status: CommandRunRecord['status']): string {
  switch (status) {
    case 'completed':
      return 'terminee';
    case 'failed':
      return 'echouee';
    case 'cancelled':
      return 'annulee';
    case 'rejected':
      return 'refusee';
    case 'running':
      return 'en cours';
    default:
      return status;
  }
}

function formatExitCode(value: number | null | undefined): string {
  if (value === undefined) {
    return 'n/a';
  }

  return value === null ? 'null' : String(value);
}

function defaultTaskSummary(status: TaskHistoryEntry['status']): string {
  switch (status) {
    case 'completed':
      return 'Tache terminee.';
    case 'failed':
      return 'La tache a echoue.';
    case 'cancelled':
      return 'La tache a ete interrompue.';
    default:
      return 'Tache en cours.';
  }
}
