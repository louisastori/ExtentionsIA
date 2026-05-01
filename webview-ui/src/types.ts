export type AppMode = 'chat' | 'edit' | 'run' | 'agent';

export interface ResolvedProviderProfile {
  id: string;
  label: string;
  providerType: 'openai' | 'anthropic' | 'google' | 'ollama' | 'openai-compatible';
  baseUrl?: string;
  model: string;
  hasApiKey: boolean;
  isLocal: boolean;
}

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  runId?: string;
  profileLabel?: string;
  model?: string;
  status: 'complete' | 'streaming' | 'error';
}

export interface TaskHistoryEntry {
  id: string;
  runId: string;
  mode: AppMode;
  userText: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  profileLabel?: string;
  model?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface ProjectMemorySnapshot {
  fingerprint: string;
  displayName: string;
  workspaceFolders: string[];
  description?: string;
  techStack: string[];
  packageScripts: string[];
  importantFiles: string[];
  updatedAt: string;
}

export interface QueuedPromptPreview {
  id: string;
  mode: AppMode;
  textPreview: string;
  createdAt: string;
}

export interface SessionSnapshot {
  sessionId: string;
  mode: AppMode;
  activeProfileId: string;
  selectedModel: string;
  defaultTemperature?: number;
  systemPrompt?: string;
  isBusy: boolean;
  busyRunId?: string;
  currentAgentRun?: AgentRunSnapshot;
  pendingAgentToolApproval?: AgentToolApprovalRequest;
  workspaceFolders: string[];
  commandHistory: CommandRunRecord[];
  pendingCommandApproval?: CommandApprovalRequest;
  terminalPolicy: TerminalPolicySnapshot;
  gpuGuard: GpuGuardSnapshot;
  profiles: ResolvedProviderProfile[];
  queuedPrompts: QueuedPromptPreview[];
  projectMemory?: ProjectMemorySnapshot;
  taskHistory: TaskHistoryEntry[];
  messages: TranscriptMessage[];
  activeEditorContext?: ActiveEditorContext;
}

export interface ActiveEditorSelectionContext {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

export interface ActiveEditorContext {
  absolutePath: string;
  workspacePath: string;
  languageId: string;
  isDirty: boolean;
  lineCount: number;
  cursorLine: number;
  cursorCharacter: number;
  focusStartLine: number;
  focusEndLine: number;
  excerptStartLine: number;
  excerptEndLine: number;
  excerpt: string;
  selection?: ActiveEditorSelectionContext;
}

export interface WorkspaceFileReadResult {
  absolutePath: string;
  workspacePath: string;
  content: string;
  lineCount: number;
  sizeBytes: number;
}

export interface WorkspaceSearchMatch {
  absolutePath: string;
  workspacePath: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  lineText: string;
}

export interface WorkspaceSearchResult {
  pattern: string;
  matches: WorkspaceSearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  lineNumberBefore?: number;
  lineNumberAfter?: number;
  text: string;
}

export interface PatchProposal {
  proposalId: string;
  absolutePath: string;
  workspacePath: string;
  operation: 'replace' | 'create';
  searchBlock?: string;
  replaceBlock: string;
  matchCount?: number;
  occurrence?: number;
  unifiedDiff: string;
  diffLines: DiffLine[];
  status: 'pending_approval';
}

export interface PatchApplyResult {
  proposalId: string;
  absolutePath: string;
  workspacePath: string;
  success: boolean;
  decision: 'approved' | 'rejected';
  message: string;
  updatedFile?: WorkspaceFileReadResult;
}

export interface TerminalPolicySnapshot {
  autoApproveWorkspaceEdits: boolean;
  autoApproveTerminal: boolean;
  commandAllowList: string[];
  commandDenyList: string[];
}

export type GpuGuardProvider = 'off' | 'auto' | 'nvidia-smi';

export type GpuGuardAction = 'warn' | 'pause' | 'stop';

export interface GpuGuardPolicy {
  enabled: boolean;
  provider: GpuGuardProvider;
  maxTemperatureC?: number;
  maxUtilizationPercent?: number;
  pollIntervalMs: number;
  action: GpuGuardAction;
}

export interface GpuDeviceSnapshot {
  name: string;
  temperatureC?: number;
  utilizationPercent?: number;
}

export interface GpuGuardSnapshot {
  policy: GpuGuardPolicy;
  status: 'disabled' | 'ready' | 'throttled' | 'unsupported' | 'error';
  provider: 'off' | 'nvidia-smi' | 'unavailable';
  updatedAt?: string;
  devices: GpuDeviceSnapshot[];
  limitExceeded: boolean;
  reasons: string[];
  error?: string;
}

export interface CommandApprovalRequest {
  approvalId: string;
  command: string;
  cwd: string;
  label?: string;
  allowlisted: boolean;
  status: 'pending_approval';
}

export interface CommandRunRecord {
  runId: string;
  command: string;
  cwd: string;
  label?: string;
  status: 'pending_approval' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandStreamEvent {
  runId: string;
  stream: 'stdout' | 'stderr';
  textDelta: string;
}

export interface AgentRunSnapshot {
  runId: string;
  status: 'idle' | 'running' | 'paused' | 'waiting_for_user' | 'completed' | 'failed' | 'cancelled';
  iteration: number;
  toolCallsUsed: number;
  maxIterations: number;
  maxToolCalls: number;
  timeBudgetMs: number;
  startedAt: string;
  stopReason?: string;
  summary?: string;
  lastAssistantText?: string;
}

export interface AgentToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: 'apply_patch' | 'create_file' | 'execute_terminal_command';
  status: 'pending_approval';
  patchProposal?: PatchProposal;
  commandApproval?: CommandApprovalRequest;
}

export interface MessageEnvelope<TType extends string, TPayload> {
  type: TType;
  requestId: string;
  timestamp: string;
  payload: TPayload;
}

export type UiMessage =
  | MessageEnvelope<'ui.ready', { webviewVersion: string }>
  | MessageEnvelope<
      'ui.chat.submit',
      {
        text: string;
        mode: AppMode;
        profileId?: string;
        model?: string;
      }
    >
  | MessageEnvelope<
      'ui.preferences.save',
      {
        profileId?: string;
        mode: AppMode;
        model?: string;
        autoApproveWorkspaceEdits?: boolean;
        autoApproveTerminal?: boolean;
        temperature?: number;
        systemPrompt?: string;
      }
    >
  | MessageEnvelope<'ui.agent.stop', { runId?: string }>
  | MessageEnvelope<'ui.agent.pause', { runId?: string }>
  | MessageEnvelope<'ui.agent.resume', { runId?: string }>
  | MessageEnvelope<'ui.workspace.readFile', { workspacePath: string }>
  | MessageEnvelope<'ui.workspace.search', { pattern: string; maxResults?: number }>
  | MessageEnvelope<
      'ui.patch.preview',
      {
        workspacePath: string;
        searchBlock: string;
        replaceBlock: string;
        occurrence?: number;
      }
    >
  | MessageEnvelope<'ui.patch.approval', { proposalId: string; decision: 'approved' | 'rejected' }>
  | MessageEnvelope<'ui.command.execute', { command: string; cwd?: string; label?: string }>
  | MessageEnvelope<'ui.command.approval', { approvalId: string; decision: 'approved' | 'rejected' }>
  | MessageEnvelope<'ui.command.stop', { runId: string }>
  | MessageEnvelope<'ui.gpuGuard.update', Partial<GpuGuardPolicy>>
  | MessageEnvelope<'ui.agent.toolApproval', { approvalId: string; decision: 'approved' | 'rejected' }>
  | MessageEnvelope<'ui.ollama.start', Record<string, never>>;

export type HostMessage =
  | MessageEnvelope<'host.session.state', SessionSnapshot>
  | MessageEnvelope<
      'host.stream.delta',
      {
        runId: string;
        textDelta: string;
      }
    >
  | MessageEnvelope<
      'host.run.status',
      {
        runId: string;
        status: 'running' | 'completed' | 'failed' | 'cancelled';
        stopReason?: string;
      }
    >
  | MessageEnvelope<'host.workspace.fileRead', WorkspaceFileReadResult>
  | MessageEnvelope<'host.workspace.searchResults', WorkspaceSearchResult>
  | MessageEnvelope<'host.patch.proposed', PatchProposal>
  | MessageEnvelope<'host.patch.result', PatchApplyResult>
  | MessageEnvelope<'host.command.proposed', CommandApprovalRequest>
  | MessageEnvelope<'host.command.started', CommandRunRecord>
  | MessageEnvelope<'host.command.stream', CommandStreamEvent>
  | MessageEnvelope<'host.command.finished', CommandRunRecord>
  | MessageEnvelope<'host.agent.status', AgentRunSnapshot>
  | MessageEnvelope<'host.agent.approvalRequired', AgentToolApprovalRequest>
  | MessageEnvelope<
      'host.preferences.saved',
      {
        message: string;
      }
    >
  | MessageEnvelope<
      'host.error',
      {
        code: string;
        message: string;
        runId?: string;
      }
    >;
