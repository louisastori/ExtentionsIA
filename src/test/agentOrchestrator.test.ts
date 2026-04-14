import assert from 'node:assert/strict';
import { AgentOrchestrator } from '../core/agent/agentOrchestrator';
import type {
  AgentLoopPolicy,
  AgentRunSnapshot,
  CanonicalAgentMessage,
  CanonicalToolCall,
  ProviderToolTurn,
  ToolExecutionResult
} from '../core/types';
import type { TestCase } from './toolRuntime.test';

const basePolicy: AgentLoopPolicy = {
  maxIterations: 4,
  maxToolCalls: 8,
  timeBudgetMs: 60_000,
  maxConsecutiveFailures: 2,
  autoApproveReadOnlyTools: true,
  autoApproveWorkspaceEdits: false,
  autoApproveTerminal: false,
  commandAllowList: ['npm test'],
  commandDenyList: ['rm -rf /']
};

export const agentOrchestratorTests: TestCase[] = [
  {
    name: 'agent completes when provider returns final text without tools',
    async run() {
      const statuses: AgentRunSnapshot[] = [];
      const capturedMessages: CanonicalAgentMessage[][] = [];
      const providerCalls: ProviderToolTurn[] = [
        {
          text: 'Task complete without tools.',
          toolCalls: [],
          finishReason: 'stop'
        }
      ];
      const orchestrator = new AgentOrchestrator(
        {
          async createAgentTurn({ messages }) {
            capturedMessages.push(messages);
            return providerCalls.shift() ?? { text: '', toolCalls: [], finishReason: 'stop' };
          }
        },
        {
          async executeToolCall(): Promise<ToolExecutionResult> {
            throw new Error('tool runtime should not be called');
          }
        }
      );

      const finalStatus = await waitForFinalStatus((onStatus) => {
        orchestrator.startRun({
          profileId: 'profile',
          goal: 'Finish the task',
          model: 'model',
          policy: basePolicy,
          onStatus: (snapshot) => {
            statuses.push(snapshot);
            onStatus(snapshot);
          },
          onApprovalRequired: async () => 'approved'
        });
      });

      assert.equal(finalStatus.status, 'completed');
      assert.equal(finalStatus.summary, 'Task complete without tools.');
      assert.equal(statuses[0]?.status, 'running');
      assert.match(String(capturedMessages[0]?.[0]?.content), /Reponds toujours en francais/);
    }
  },
  {
    name: 'agent pauses for approval, executes tool, then completes',
    async run() {
      const providerTurns: ProviderToolTurn[] = [
        {
          text: 'I need approval before running the command.',
          toolCalls: [
            {
              id: 'tool-approval',
              name: 'execute_terminal_command',
              arguments: {
                command: 'npm test'
              }
            }
          ],
          finishReason: 'tool_calls'
        },
        {
          text: 'All done after approval.',
          toolCalls: [],
          finishReason: 'stop'
        }
      ];
      const seenApprovals: string[] = [];
      const executedTools: CanonicalToolCall[] = [];
      const statuses: AgentRunSnapshot[] = [];

      const orchestrator = new AgentOrchestrator(
        {
          async createAgentTurn() {
            const next = providerTurns.shift();
            if (!next) {
              throw new Error('provider called too many times');
            }
            return next;
          }
        },
        {
          async executeToolCall(toolCall, _policy, requestApproval): Promise<ToolExecutionResult> {
            executedTools.push(toolCall);
            const decision = await requestApproval({
              approvalId: 'agent-approval-1',
              toolCallId: toolCall.id,
              toolName: 'execute_terminal_command',
              status: 'pending_approval',
              commandApproval: {
                approvalId: 'cmd-approval-1',
                command: 'npm test',
                cwd: 'C:/workspace',
                allowlisted: true,
                status: 'pending_approval'
              }
            });
            seenApprovals.push(decision);
            return {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              success: true,
              content: 'Command completed'
            };
          }
        }
      );

      const finalStatus = await waitForFinalStatus((onStatus) => {
        orchestrator.startRun({
          profileId: 'profile',
          goal: 'Run tests',
          model: 'model',
          policy: basePolicy,
          onStatus: (snapshot) => {
            statuses.push(snapshot);
            onStatus(snapshot);
          },
          onApprovalRequired: async (approval) => {
            assert.equal(approval.toolName, 'execute_terminal_command');
            return 'approved';
          }
        });
      });

      assert.deepEqual(seenApprovals, ['approved']);
      assert.equal(executedTools.length, 1);
      assert.ok(statuses.some((snapshot) => snapshot.status === 'waiting_for_user'));
      assert.equal(finalStatus.status, 'completed');
      assert.equal(finalStatus.summary, 'All done after approval.');
    }
  },
  {
    name: 'agent retries once when provider announces an action without tool call',
    async run() {
      const capturedMessages: CanonicalAgentMessage[][] = [];
      const providerTurns: ProviderToolTurn[] = [
        {
          text: "First, I'll check the git status to see current changes.",
          toolCalls: [],
          finishReason: 'stop'
        },
        {
          text: 'Repository inspected.',
          toolCalls: [
            {
              id: 'tool-git-status',
              name: 'execute_terminal_command',
              arguments: {
                command: 'git status'
              }
            }
          ],
          finishReason: 'tool_calls'
        },
        {
          text: 'J ai termine.',
          toolCalls: [
            {
              id: 'tool-complete',
              name: 'complete_task',
              arguments: {
                summary: 'Etat du depot verifie et resume pret.'
              }
            }
          ],
          finishReason: 'tool_calls'
        }
      ];
      const executedTools: string[] = [];

      const orchestrator = new AgentOrchestrator(
        {
          async createAgentTurn({ messages }) {
            capturedMessages.push(messages.map((message) => ({ ...message })));
            const next = providerTurns.shift();
            if (!next) {
              throw new Error('provider called too many times');
            }
            return next;
          }
        },
        {
          async executeToolCall(toolCall): Promise<ToolExecutionResult> {
            executedTools.push(toolCall.name);
            return {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              success: true,
              content:
                toolCall.name === 'complete_task'
                  ? String(toolCall.arguments.summary)
                  : 'On branch main\nnothing to commit, working tree clean'
            };
          }
        }
      );

      const finalStatus = await waitForFinalStatus((onStatus) => {
        orchestrator.startRun({
          profileId: 'profile',
          goal: 'Fait un commit',
          model: 'model',
          policy: basePolicy,
          onStatus: onStatus,
          onApprovalRequired: async () => 'approved'
        });
      });

      assert.deepEqual(executedTools, ['execute_terminal_command', 'complete_task']);
      assert.equal(finalStatus.status, 'completed');
      assert.equal(finalStatus.summary, 'Etat du depot verifie et resume pret.');
      assert.equal(capturedMessages.length, 3);
      assert.ok(
        capturedMessages[1]?.some((message) => 'content' in message && /Continue en mode agent/.test(String(message.content)))
      );
    }
  }
];

function waitForFinalStatus(
  start: (onStatus: (snapshot: AgentRunSnapshot) => void) => void
): Promise<AgentRunSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for final agent status'));
    }, 5_000);

    start((snapshot) => {
      if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        clearTimeout(timer);
        resolve(snapshot);
      }
    });
  });
}
