import type {
  AgentToolApprovalRequest,
  AgentLoopPolicy,
  CommandApprovalRequest,
  CommandExecutionRequest,
  CommandRunRecord,
  CommandStreamEvent,
  CanonicalToolCall,
  PatchApplyResult,
  PatchProposal,
  ToolExecutionResult,
  WorkspaceFileReadResult,
  WorkspaceSearchResult
} from '../types';
import { createId } from '../protocol/messages';

export interface ToolRuntimeWorkspaceBackend {
  readFile(workspacePath: string): Promise<WorkspaceFileReadResult>;
  searchWorkspace(pattern: string, maxResults?: number): Promise<WorkspaceSearchResult>;
}

export interface ToolRuntimePatchBackend {
  previewPatch(input: {
    workspacePath: string;
    searchBlock: string;
    replaceBlock: string;
    occurrence?: number;
  }): Promise<PatchProposal>;
  previewFileCreation(input: {
    workspacePath: string;
    content: string;
  }): Promise<PatchProposal>;
  resolveApproval(proposalId: string, decision: 'approved' | 'rejected'): Promise<PatchApplyResult>;
}

export interface ToolRuntimeTerminalBackend {
  prepareCommand(
    request: CommandExecutionRequest,
    policy: {
      autoApproveTerminal: boolean;
      commandAllowList: string[];
      commandDenyList: string[];
    }
  ): {
    kind: 'approval_required' | 'start_now';
    approval?: CommandApprovalRequest;
    run?: CommandRunRecord;
  };
  startApprovedCommand(approval: CommandApprovalRequest): CommandRunRecord;
  executeCommandAndWait(
    run: CommandRunRecord,
    callbacks?: {
      onStream?: (event: CommandStreamEvent) => void;
    }
  ): Promise<CommandRunRecord>;
}

export class ToolRuntime {
  public constructor(
    private readonly workspaceService: ToolRuntimeWorkspaceBackend,
    private readonly patchService: ToolRuntimePatchBackend,
    private readonly terminalService: ToolRuntimeTerminalBackend
  ) {}

  public async executeToolCall(
    toolCall: CanonicalToolCall,
    policy: AgentLoopPolicy,
    requestApproval?: (approval: AgentToolApprovalRequest) => Promise<'approved' | 'rejected'>
  ): Promise<ToolExecutionResult> {
    try {
      switch (toolCall.name) {
        case 'read_file':
          return await this.readFile(toolCall);
        case 'search_workspace':
          return await this.searchWorkspace(toolCall);
        case 'create_file':
          return await this.createFile(toolCall, policy, requestApproval);
        case 'apply_patch':
          return await this.applyPatch(toolCall, policy, requestApproval);
        case 'execute_terminal_command':
          return await this.executeTerminalCommand(toolCall, policy, requestApproval);
        case 'complete_task':
          return await this.completeTask(toolCall);
        default:
          return {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            success: false,
            content: `Unknown tool: ${toolCall.name}`
          };
      }
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: false,
        content: normalizeErrorMessage(error)
      };
    }
  }

  private async readFile(toolCall: CanonicalToolCall): Promise<ToolExecutionResult> {
    const workspacePath = asWorkspacePath(toolCall.arguments);
    const file = await this.workspaceService.readFile(workspacePath);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      success: true,
      content: file.content,
      structuredContent: {
        absolutePath: file.absolutePath,
        workspacePath: file.workspacePath,
        lineCount: file.lineCount,
        sizeBytes: file.sizeBytes
      }
    };
  }

  private async searchWorkspace(toolCall: CanonicalToolCall): Promise<ToolExecutionResult> {
    const pattern = asString(toolCall.arguments.pattern, 'pattern');
    const maxResults = asOptionalNumber(toolCall.arguments.maxResults) ?? 50;
    const result = await this.workspaceService.searchWorkspace(pattern, maxResults);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      success: true,
      content: JSON.stringify(result, null, 2),
      structuredContent: {
        totalMatches: result.totalMatches,
        truncated: result.truncated
      }
    };
  }

  private async createFile(
    toolCall: CanonicalToolCall,
    policy: AgentLoopPolicy,
    requestApproval?: (approval: AgentToolApprovalRequest) => Promise<'approved' | 'rejected'>
  ): Promise<ToolExecutionResult> {
    const proposal = await this.patchService.previewFileCreation({
      workspacePath: asWorkspacePath(toolCall.arguments),
      content: asString(toolCall.arguments.content, 'content')
    });

    let decision: 'approved' | 'rejected' = 'approved';
    if (!policy.autoApproveWorkspaceEdits) {
      if (!requestApproval) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: false,
          content: 'Workspace edit approval is required but no approval handler is available.'
        };
      }

      decision = await requestApproval({
        approvalId: createId('agent-approval'),
        toolCallId: toolCall.id,
        toolName: 'create_file',
        status: 'pending_approval',
        patchProposal: proposal
      });
    }

    const result = await this.patchService.resolveApproval(proposal.proposalId, decision);

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      success: result.success,
      content: result.message,
      structuredContent: {
        absolutePath: result.absolutePath,
        workspacePath: result.workspacePath
      }
    };
  }

  private async applyPatch(
    toolCall: CanonicalToolCall,
    policy: AgentLoopPolicy,
    requestApproval?: (approval: AgentToolApprovalRequest) => Promise<'approved' | 'rejected'>
  ): Promise<ToolExecutionResult> {
    const proposal = await this.patchService.previewPatch({
      workspacePath: asWorkspacePath(toolCall.arguments),
      searchBlock: asString(toolCall.arguments.searchBlock, 'searchBlock'),
      replaceBlock: asString(toolCall.arguments.replaceBlock, 'replaceBlock'),
      occurrence: asOptionalNumber(toolCall.arguments.occurrence)
    });

    let decision: 'approved' | 'rejected' = 'approved';
    if (!policy.autoApproveWorkspaceEdits) {
      if (!requestApproval) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: false,
          content: 'Workspace edit approval is required but no approval handler is available.'
        };
      }

      decision = await requestApproval({
        approvalId: createId('agent-approval'),
        toolCallId: toolCall.id,
        toolName: 'apply_patch',
        status: 'pending_approval',
        patchProposal: proposal
      });
    }

    const result = await this.patchService.resolveApproval(proposal.proposalId, decision);

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      success: result.success,
      content: result.message,
      structuredContent: {
        absolutePath: result.absolutePath,
        workspacePath: result.workspacePath
      }
    };
  }

  private async executeTerminalCommand(
    toolCall: CanonicalToolCall,
    policy: AgentLoopPolicy,
    requestApproval?: (approval: AgentToolApprovalRequest) => Promise<'approved' | 'rejected'>
  ): Promise<ToolExecutionResult> {
    const prepared = this.terminalService.prepareCommand(
      {
        command: asString(toolCall.arguments.command, 'command'),
        cwd: asOptionalString(toolCall.arguments.cwd),
        label: asOptionalString(toolCall.arguments.label)
      },
      {
        autoApproveTerminal: policy.autoApproveTerminal,
        commandAllowList: policy.commandAllowList,
        commandDenyList: policy.commandDenyList
      }
    );

    let run = prepared.run;

    if (prepared.kind === 'approval_required' && prepared.approval) {
      if (!requestApproval) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: false,
          content: 'Terminal approval is required but no approval handler is available.'
        };
      }

      const decision = await requestApproval({
        approvalId: createId('agent-approval'),
        toolCallId: toolCall.id,
        toolName: 'execute_terminal_command',
        status: 'pending_approval',
        commandApproval: prepared.approval
      });

      if (decision === 'rejected') {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: false,
          content: 'Terminal command rejected from the UI.'
        };
      }

      run = this.terminalService.startApprovedCommand(prepared.approval);
    }

    if (!run) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: false,
        content: 'Unable to start the terminal command.'
      };
    }

    const result = await this.terminalService.executeCommandAndWait(run);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      success: result.status === 'completed',
      content: JSON.stringify(
        {
          command: result.command,
          cwd: result.cwd,
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        },
        null,
        2
      ),
      structuredContent: {
        exitCode: result.exitCode ?? null,
        status: result.status
      }
    };
  }

  private async completeTask(toolCall: CanonicalToolCall): Promise<ToolExecutionResult> {
    const summary = asString(toolCall.arguments.summary, 'summary');
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      success: true,
      content: summary,
      structuredContent: {
        summary
      }
    };
  }
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tool argument "${fieldName}" must be a non-empty string.`);
  }

  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asWorkspacePath(argumentsValue: Record<string, unknown>): string {
  if (typeof argumentsValue.workspacePath === 'string' && argumentsValue.workspacePath.length > 0) {
    return argumentsValue.workspacePath;
  }

  return asString(argumentsValue.absolutePath, 'workspacePath');
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
