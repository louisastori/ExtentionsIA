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
    memoryContext?: string;
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
    let textOnlyRetryCount = 0;
    let summary = '';
    const messages: CanonicalAgentMessage[] = [
      {
        role: 'system',
        content: buildAgentSystemPrompt(input.policy, input.memoryContext)
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
            if (shouldRetryAfterTextOnlyTurn(turn.text, textOnlyRetryCount)) {
              textOnlyRetryCount += 1;
              messages.push({
                role: 'user',
                content:
                  'Continue en mode agent. Ne t arrete pas apres avoir decrit une intention. Appelle maintenant l outil adapte pour agir sur le workspace, ou appelle complete_task si le travail est vraiment termine.'
              });
              continue;
            }

            summary = turn.text.trim();
            publishStatus(buildSnapshot('completed', { stopReason: 'assistant_completed_without_tool_call', summary }));
            return;
          }

          textOnlyRetryCount = 0;
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

function buildAgentSystemPrompt(policy: AgentLoopPolicy, memoryContext?: string): string {
  const sections = [
    'Tu es esctentionIALocal en mode agent borne dans VS Code.',
    'Reponds toujours en francais, sauf si l utilisateur demande explicitement une autre langue.',
    'Utilise les outils disponibles pour inspecter les fichiers, rechercher dans le workspace, creer de nouveaux fichiers, appliquer des patches cibles sur les fichiers existants, executer des commandes terminal quand elles sont autorisees, puis terminer avec complete_task.',
    'Quand un outil attend un chemin de fichier, utilise toujours un chemin relatif a la racine du workspace.',
    'Si l utilisateur demande des modifications du workspace, utilise create_file pour les nouveaux fichiers et apply_patch pour les fichiers existants au lieu de repondre uniquement avec du code.',
    'Agis immediatement sur la demande au lieu de demander une confirmation.',
    'N ecris pas seulement ce que tu vas faire. Si tu dois verifier, lire, chercher, modifier ou lancer une commande, emets l appel d outil correspondant dans le meme tour.',
    'Fais des suppositions raisonnables, choisis l implementation la plus pratique et avance jusqu a la fin de la tache.',
    'Pose une question uniquement si un detail manquant rend le changement dangereux ou impossible.',
    'Ne declare pas la tache terminee sans appeler complete_task ou sans fournir une reponse finale claire quand aucun autre outil n est necessaire.',
    'N essaie jamais d acceder a des fichiers en dehors du workspace.',
    `Tu es borne par maxIterations=${policy.maxIterations}, maxToolCalls=${policy.maxToolCalls}, timeBudgetMs=${policy.timeBudgetMs}.`,
    `Modifications du workspace auto-approuvees: ${policy.autoApproveWorkspaceEdits}. Terminal auto-approuve: ${policy.autoApproveTerminal}.`
  ];

  if (memoryContext) {
    sections.push(memoryContext);
  }

  return sections.join(' ');
}

function shouldRetryAfterTextOnlyTurn(text: string, textOnlyRetryCount: number): boolean {
  if (textOnlyRetryCount >= 1) {
    return false;
  }

  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ' ');

  return /\b(i(?:\s|')?ll|i will|let me|first|next|checking|check|inspect|search|read|open|modify|patch|run|commit|verify|je vais|d abord|ensuite|je commence|je verifie|verifier|regarder|chercher|lire|ouvrir|modifier|appliquer|lancer)\b/.test(
    normalized
  );
}
