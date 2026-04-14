import { createId } from '../protocol/messages';
import { canonicalToolDefinitions } from '../tools/toolDefinitions';
import type {
  AgentLoopPolicy,
  AgentRunSnapshot,
  AgentToolApprovalRequest,
  CanonicalAgentMessage,
  CanonicalToolDefinition,
  CanonicalToolCall,
  ProviderToolTurn,
  ToolExecutionResult
} from '../types';

export interface AgentProviderBackend {
  createAgentTurn(request: {
    profileId: string;
    model?: string;
    messages: CanonicalAgentMessage[];
    tools: CanonicalToolDefinition[];
    signal?: AbortSignal;
  }): Promise<ProviderToolTurn>;
}

export interface AgentToolExecutor {
  executeToolCall(
    toolCall: CanonicalToolCall,
    policy: AgentLoopPolicy,
    requestApproval: (approval: AgentToolApprovalRequest) => Promise<'approved' | 'rejected'>
  ): Promise<ToolExecutionResult>;
}

export interface AgentRunHandle {
  readonly runId: string;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export class AgentOrchestrator {
  public constructor(
    private readonly providerRegistry: AgentProviderBackend,
    private readonly toolRuntime: AgentToolExecutor
  ) {}

  public startRun(input: {
    profileId: string;
    model?: string;
    goal: string;
    policy: AgentLoopPolicy;
    signal?: AbortSignal;
    onStatus: (snapshot: AgentRunSnapshot) => void;
    onApprovalRequired: (approval: AgentToolApprovalRequest, snapshot: AgentRunSnapshot) => Promise<'approved' | 'rejected'>;
  }): AgentRunHandle {
    const runId = createId('agent');
    let paused = false;
    let resumedResolver: (() => void) | undefined;
    let cancelled = false;
    const startedAt = Date.now();
    const agentSignal = input.signal;

    const buildSnapshot = (
      status: AgentRunSnapshot['status'],
      extra?: Partial<AgentRunSnapshot>
    ): AgentRunSnapshot => ({
      runId,
      status,
      iteration,
      toolCallsUsed,
      maxIterations: input.policy.maxIterations,
      maxToolCalls: input.policy.maxToolCalls,
      timeBudgetMs: input.policy.timeBudgetMs,
      startedAt: new Date(startedAt).toISOString(),
      ...extra
    });

    const publishStatus = (snapshot: AgentRunSnapshot): void => {
      input.onStatus(snapshot);
    };

    const waitIfPaused = async (): Promise<void> => {
      if (!paused) {
        return;
      }

      publishStatus(buildSnapshot('paused'));

      await new Promise<void>((resolve) => {
        resumedResolver = resolve;
      });
    };

    let iteration = 0;
    let toolCallsUsed = 0;
    let consecutiveFailures = 0;
    let summary = '';
    const messages: CanonicalAgentMessage[] = [
      {
        role: 'system',
        content: buildAgentSystemPrompt(input.policy)
      },
      {
        role: 'user',
        content: input.goal
      }
    ];

    void (async () => {
      publishStatus(buildSnapshot('running'));

      try {
        while (!cancelled) {
          await waitIfPaused();
          ensureBudgets(startedAt, iteration, toolCallsUsed, input.policy);

          if (agentSignal?.aborted) {
            throw new Error('Agent run aborted');
          }

          const turn = await this.providerRegistry.createAgentTurn({
            profileId: input.profileId,
            model: input.model,
            messages,
            tools: canonicalToolDefinitions,
            signal: agentSignal
          });

          messages.push({
            role: 'assistant',
            content: turn.text,
            toolCalls: turn.toolCalls
          });

          publishStatus(buildSnapshot('running', { lastAssistantText: turn.text }));

          if (turn.toolCalls.length === 0) {
            summary = turn.text.trim();
            publishStatus(buildSnapshot('completed', { stopReason: 'assistant_completed_without_tool_call', summary }));
            return;
          }

          iteration += 1;

          for (const toolCall of turn.toolCalls) {
            await waitIfPaused();
            ensureBudgets(startedAt, iteration, toolCallsUsed, input.policy);
            toolCallsUsed += 1;

            const result = await this.executeTool(toolCall, input.policy, async (approval) => {
              publishStatus(
                buildSnapshot('waiting_for_user', {
                  lastAssistantText: turn.text
                })
              );
              return input.onApprovalRequired(approval, buildSnapshot('waiting_for_user', { lastAssistantText: turn.text }));
            });
            messages.push({
              role: 'tool',
              name: result.toolName,
              toolCallId: result.toolCallId,
              content: result.content,
              isError: !result.success
            });

            if (!result.success) {
              consecutiveFailures += 1;
              if (consecutiveFailures >= input.policy.maxConsecutiveFailures) {
                publishStatus(buildSnapshot('failed', { stopReason: 'too_many_failures', summary: result.content }));
                return;
              }
            } else {
              consecutiveFailures = 0;
            }

            if (toolCall.name === 'complete_task' && result.success) {
              summary = result.content;
              publishStatus(buildSnapshot('completed', { stopReason: 'complete_task_called', summary }));
              return;
            }
          }
        }

        publishStatus(buildSnapshot('cancelled', { stopReason: 'cancelled_by_user', summary }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publishStatus(
          buildSnapshot(cancelled ? 'cancelled' : 'failed', {
            stopReason: cancelled ? 'cancelled_by_user' : message,
            summary
          })
        );
      }
    })();

    return {
      runId,
      pause() {
        paused = true;
      },
      resume() {
        if (!paused) {
          return;
        }

        paused = false;
        resumedResolver?.();
        resumedResolver = undefined;
      },
      cancel() {
        cancelled = true;
        paused = false;
        resumedResolver?.();
        resumedResolver = undefined;
      }
    };
  }

  private executeTool(
    toolCall: CanonicalToolCall,
    policy: AgentLoopPolicy,
    requestApproval: (approval: AgentToolApprovalRequest) => Promise<'approved' | 'rejected'>
  ): Promise<ToolExecutionResult> {
    return this.toolRuntime.executeToolCall(toolCall, policy, requestApproval);
  }
}

function ensureBudgets(
  startedAt: number,
  iteration: number,
  toolCallsUsed: number,
  policy: AgentLoopPolicy
): void {
  if (Date.now() - startedAt > policy.timeBudgetMs) {
    throw new Error('time_budget_exceeded');
  }

  if (iteration > policy.maxIterations) {
    throw new Error('iteration_budget_exceeded');
  }

  if (toolCallsUsed > policy.maxToolCalls) {
    throw new Error('tool_budget_exceeded');
  }
}

function buildAgentSystemPrompt(policy: AgentLoopPolicy): string {
  return [
    'You are esctentionIALocal running in bounded agent mode inside VS Code.',
    'Use the available tools to inspect files, search the workspace, create new files, apply focused patches to existing files, run terminal commands when allowed, and finish by calling complete_task.',
    'When a tool expects a file path, always use a path relative to the workspace root.',
    'If the user asks for workspace changes, use create_file for new files and apply_patch for existing files instead of replying with code only.',
    'Act immediately on the user request instead of asking for confirmation.',
    'Make reasonable assumptions, pick the most practical implementation, and keep moving until the task is done.',
    'Only ask a question when a missing detail would make the change unsafe or impossible.',
    'Do not claim completion without either calling complete_task or returning a clear final answer when no further tools are needed.',
    'Never try to access files outside the workspace.',
    `You are bounded by maxIterations=${policy.maxIterations}, maxToolCalls=${policy.maxToolCalls}, timeBudgetMs=${policy.timeBudgetMs}.`,
    `Workspace edits auto-approved: ${policy.autoApproveWorkspaceEdits}. Terminal auto-approved: ${policy.autoApproveTerminal}.`
  ].join(' ');
}
