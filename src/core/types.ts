export type AppMode = 'chat' | 'edit' | 'run' | 'agent';

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | 'openai-compatible';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ProviderCapabilities {
  streaming?: boolean;
  toolCalling?: boolean;
  jsonMode?: boolean;
  vision?: boolean;
  reasoningEffort?: boolean;
  parallelToolCalls?: boolean;
}

export interface ProviderProfile {
  id: string;
  label: string;
  providerType: ProviderType;
  baseUrl?: string;
  apiKeySecretRef?: string;
  model: string;
  fallbackModel?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  customHeaders?: Record<string, string>;
  capabilities?: ProviderCapabilities;
}

export interface ProvidersConfig {
  version: 1;
  activeProfileId?: string;
  profiles: ProviderProfile[];
}

export interface ResolvedProviderProfile extends ProviderProfile {
  hasApiKey: boolean;
  isLocal: boolean;
}

export interface CanonicalChatMessage {
  role: ChatRole;
  content: string;
}

export interface ProviderExecutionContext {
  profile: ProviderProfile;
  model: string;
  apiKey?: string;
  messages: CanonicalChatMessage[];
  signal?: AbortSignal;
}

export type ProviderEvent =
  | {
      type: 'text-delta';
      text: string;
    }
  | {
      type: 'done';
    };

export interface TranscriptMessage {
  id: string;
  role: Exclude<ChatRole, 'system'>;
  content: string;
  createdAt: string;
  runId?: string;
  profileId?: string;
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
  profileId?: string;
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

export interface PersistedSessionState {
  version: 1;
  sessionId: string;
  mode: AppMode;
  activeProfileId: string;
  selectedModel: string;
  messages: TranscriptMessage[];
  commandHistory: CommandRunRecord[];
  taskHistory: TaskHistoryEntry[];
  projectMemory?: ProjectMemorySnapshot;
}

export interface RunStatusPayload {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stopReason?: string;
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

export interface CommandExecutionRequest {
  command: string;
  cwd?: string;
  label?: string;
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

export interface AgentLoopPolicy {
  maxIterations: number;
  maxToolCalls: number;
  timeBudgetMs: number;
  maxConsecutiveFailures: number;
  autoApproveReadOnlyTools: boolean;
  autoApproveWorkspaceEdits: boolean;
  autoApproveTerminal: boolean;
  commandAllowList: string[];
  commandDenyList: string[];
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

export interface CanonicalToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type CanonicalAgentMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string;
      toolCalls?: CanonicalToolCall[];
    }
  | {
      role: 'tool';
      name: string;
      toolCallId: string;
      content: string;
      isError?: boolean;
    };

export interface ProviderToolExecutionContext {
  profile: ProviderProfile;
  model: string;
  apiKey?: string;
  messages: CanonicalAgentMessage[];
  tools: CanonicalToolDefinition[];
  signal?: AbortSignal;
}

export interface ProviderToolTurn {
  text: string;
  toolCalls: CanonicalToolCall[];
  finishReason?: string;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  content: string;
  structuredContent?: Record<string, unknown>;
}

export interface AgentToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: 'apply_patch' | 'create_file' | 'execute_terminal_command';
  status: 'pending_approval';
  patchProposal?: PatchProposal;
  commandApproval?: CommandApprovalRequest;
}
