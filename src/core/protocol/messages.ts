import type {
  AgentToolApprovalRequest,
  AgentRunSnapshot,
  AppMode,
  CommandApprovalRequest,
  CommandRunRecord,
  CommandStreamEvent,
  GpuGuardPolicy,
  PatchApplyResult,
  PatchProposal,
  RunStatusPayload,
  SessionSnapshot,
  WorkspaceFileReadResult,
  WorkspaceSearchResult
} from '../types';

export interface MessageEnvelope<TType extends string, TPayload> {
  type: TType;
  requestId: string;
  timestamp: string;
  payload: TPayload;
}

export type UiReadyMessage = MessageEnvelope<'ui.ready', { webviewVersion: string }>;

export type UiChatSubmitMessage = MessageEnvelope<
  'ui.chat.submit',
  {
    text: string;
    mode: AppMode;
    profileId?: string;
    model?: string;
  }
>;

export type UiPreferencesSaveMessage = MessageEnvelope<
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
>;

export type UiAgentControlMessage = MessageEnvelope<
  'ui.agent.stop' | 'ui.agent.pause' | 'ui.agent.resume',
  {
    runId?: string;
  }
>;

export type UiReadFileMessage = MessageEnvelope<
  'ui.workspace.readFile',
  {
    workspacePath: string;
  }
>;

export type UiSearchWorkspaceMessage = MessageEnvelope<
  'ui.workspace.search',
  {
    pattern: string;
    maxResults?: number;
  }
>;

export type UiPatchPreviewMessage = MessageEnvelope<
  'ui.patch.preview',
  {
    workspacePath: string;
    searchBlock: string;
    replaceBlock: string;
    occurrence?: number;
  }
>;

export type UiPatchApprovalMessage = MessageEnvelope<
  'ui.patch.approval',
  {
    proposalId: string;
    decision: 'approved' | 'rejected';
  }
>;

export type UiCommandExecuteMessage = MessageEnvelope<
  'ui.command.execute',
  {
    command: string;
    cwd?: string;
    label?: string;
  }
>;

export type UiCommandApprovalMessage = MessageEnvelope<
  'ui.command.approval',
  {
    approvalId: string;
    decision: 'approved' | 'rejected';
  }
>;

export type UiCommandStopMessage = MessageEnvelope<
  'ui.command.stop',
  {
    runId: string;
  }
>;

export type UiGpuGuardUpdateMessage = MessageEnvelope<'ui.gpuGuard.update', Partial<GpuGuardPolicy>>;

export type UiAgentToolApprovalMessage = MessageEnvelope<
  'ui.agent.toolApproval',
  {
    approvalId: string;
    decision: 'approved' | 'rejected';
  }
>;

export type UiOllamaStartMessage = MessageEnvelope<'ui.ollama.start', Record<string, never>>;

export type UiMessage =
  | UiReadyMessage
  | UiChatSubmitMessage
  | UiPreferencesSaveMessage
  | UiAgentControlMessage
  | UiReadFileMessage
  | UiSearchWorkspaceMessage
  | UiPatchPreviewMessage
  | UiPatchApprovalMessage
  | UiCommandExecuteMessage
  | UiCommandApprovalMessage
  | UiCommandStopMessage
  | UiGpuGuardUpdateMessage
  | UiAgentToolApprovalMessage
  | UiOllamaStartMessage;

export type HostSessionStateMessage = MessageEnvelope<'host.session.state', SessionSnapshot>;

export type HostStreamDeltaMessage = MessageEnvelope<
  'host.stream.delta',
  {
    runId: string;
    textDelta: string;
  }
>;

export type HostRunStatusMessage = MessageEnvelope<'host.run.status', RunStatusPayload>;

export type HostReadFileMessage = MessageEnvelope<'host.workspace.fileRead', WorkspaceFileReadResult>;

export type HostSearchResultsMessage = MessageEnvelope<'host.workspace.searchResults', WorkspaceSearchResult>;

export type HostPatchProposedMessage = MessageEnvelope<'host.patch.proposed', PatchProposal>;

export type HostPatchResultMessage = MessageEnvelope<'host.patch.result', PatchApplyResult>;

export type HostCommandProposedMessage = MessageEnvelope<'host.command.proposed', CommandApprovalRequest>;

export type HostCommandStartedMessage = MessageEnvelope<'host.command.started', CommandRunRecord>;

export type HostCommandStreamMessage = MessageEnvelope<'host.command.stream', CommandStreamEvent>;

export type HostCommandFinishedMessage = MessageEnvelope<'host.command.finished', CommandRunRecord>;

export type HostAgentStatusMessage = MessageEnvelope<'host.agent.status', AgentRunSnapshot>;

export type HostAgentApprovalMessage = MessageEnvelope<'host.agent.approvalRequired', AgentToolApprovalRequest>;

export type HostPreferencesSavedMessage = MessageEnvelope<
  'host.preferences.saved',
  {
    message: string;
  }
>;

export type HostErrorMessage = MessageEnvelope<
  'host.error',
  {
    code: string;
    message: string;
    runId?: string;
  }
>;

export type HostMessage =
  | HostSessionStateMessage
  | HostStreamDeltaMessage
  | HostRunStatusMessage
  | HostReadFileMessage
  | HostSearchResultsMessage
  | HostPatchProposedMessage
  | HostPatchResultMessage
  | HostCommandProposedMessage
  | HostCommandStartedMessage
  | HostCommandStreamMessage
  | HostCommandFinishedMessage
  | HostAgentStatusMessage
  | HostAgentApprovalMessage
  | HostPreferencesSavedMessage
  | HostErrorMessage;

export function createHostMessage<TType extends HostMessage['type'], TPayload>(
  type: TType,
  payload: TPayload,
  requestId = createId('host')
): MessageEnvelope<TType, TPayload> {
  return {
    type,
    requestId,
    timestamp: new Date().toISOString(),
    payload
  };
}

export function isUiReadyMessage(value: unknown): value is UiReadyMessage {
  return hasType(value, 'ui.ready');
}

export function isUiChatSubmitMessage(value: unknown): value is UiChatSubmitMessage {
  return hasType(value, 'ui.chat.submit');
}

export function isUiPreferencesSaveMessage(value: unknown): value is UiPreferencesSaveMessage {
  return hasType(value, 'ui.preferences.save');
}

export function isUiAgentControlMessage(value: unknown): value is UiAgentControlMessage {
  return (
    hasType(value, 'ui.agent.stop') ||
    hasType(value, 'ui.agent.pause') ||
    hasType(value, 'ui.agent.resume')
  );
}

export function isUiReadFileMessage(value: unknown): value is UiReadFileMessage {
  return hasType(value, 'ui.workspace.readFile');
}

export function isUiSearchWorkspaceMessage(value: unknown): value is UiSearchWorkspaceMessage {
  return hasType(value, 'ui.workspace.search');
}

export function isUiPatchPreviewMessage(value: unknown): value is UiPatchPreviewMessage {
  return hasType(value, 'ui.patch.preview');
}

export function isUiPatchApprovalMessage(value: unknown): value is UiPatchApprovalMessage {
  return hasType(value, 'ui.patch.approval');
}

export function isUiCommandExecuteMessage(value: unknown): value is UiCommandExecuteMessage {
  return hasType(value, 'ui.command.execute');
}

export function isUiCommandApprovalMessage(value: unknown): value is UiCommandApprovalMessage {
  return hasType(value, 'ui.command.approval');
}

export function isUiCommandStopMessage(value: unknown): value is UiCommandStopMessage {
  return hasType(value, 'ui.command.stop');
}

export function isUiGpuGuardUpdateMessage(value: unknown): value is UiGpuGuardUpdateMessage {
  return hasType(value, 'ui.gpuGuard.update');
}

export function isUiAgentToolApprovalMessage(value: unknown): value is UiAgentToolApprovalMessage {
  return hasType(value, 'ui.agent.toolApproval');
}

export function isUiOllamaStartMessage(value: unknown): value is UiOllamaStartMessage {
  return hasType(value, 'ui.ollama.start');
}

export function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasType(value: unknown, type: string): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (value as { type?: string }).type === type;
}
