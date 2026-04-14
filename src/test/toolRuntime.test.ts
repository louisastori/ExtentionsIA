import assert from 'node:assert/strict';
import { ToolRuntime } from '../core/tools/toolRuntime';
import type {
  AgentLoopPolicy,
  AgentToolApprovalRequest,
  CommandApprovalRequest,
  CommandRunRecord,
  PatchApplyResult,
  PatchProposal,
  WorkspaceFileReadResult,
  WorkspaceSearchResult
} from '../core/types';

export interface TestCase {
  name: string;
  run(): Promise<void>;
}

const basePolicy: AgentLoopPolicy = {
  maxIterations: 5,
  maxToolCalls: 10,
  timeBudgetMs: 60_000,
  maxConsecutiveFailures: 2,
  autoApproveReadOnlyTools: true,
  autoApproveWorkspaceEdits: false,
  autoApproveTerminal: false,
  commandAllowList: ['npm test'],
  commandDenyList: ['rm -rf /']
};

export const toolRuntimeTests: TestCase[] = [
  {
    name: 'read_file returns content and metadata',
    async run() {
      const runtime = new ToolRuntime(
        {
          async readFile(workspacePath: string): Promise<WorkspaceFileReadResult> {
            return {
              absolutePath: 'C:/workspace/src/file.ts',
              workspacePath,
              content: 'hello world',
              lineCount: 1,
              sizeBytes: 11
            };
          },
          async searchWorkspace(): Promise<WorkspaceSearchResult> {
            throw new Error('not used');
          }
        },
        failingPatchBackend(),
        failingTerminalBackend()
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-1',
          name: 'read_file',
          arguments: {
            workspacePath: 'src/file.ts'
          }
        },
        basePolicy
      );

      assert.equal(result.success, true);
      assert.equal(result.content, 'hello world');
      assert.deepEqual(result.structuredContent, {
        absolutePath: 'C:/workspace/src/file.ts',
        workspacePath: 'src/file.ts',
        lineCount: 1,
        sizeBytes: 11
      });
    }
  },
  {
    name: 'tool runtime returns a structured failure when tool arguments are invalid',
    async run() {
      const runtime = new ToolRuntime(
        failingWorkspaceBackend(),
        failingPatchBackend(),
        failingTerminalBackend()
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-invalid',
          name: 'complete_task',
          arguments: {}
        },
        basePolicy
      );

      assert.equal(result.success, false);
      assert.equal(result.toolName, 'complete_task');
      assert.match(result.content, /Tool argument "summary" must be a non-empty string\./);
    }
  },
  {
    name: 'apply_patch asks for approval and applies approved patch',
    async run() {
      const proposal: PatchProposal = {
        proposalId: 'patch-1',
        absolutePath: 'C:/workspace/app.ts',
        workspacePath: 'src/app.ts',
        operation: 'replace',
        searchBlock: 'oldValue',
        replaceBlock: 'newValue',
        matchCount: 1,
        occurrence: 1,
        unifiedDiff: '@@',
        diffLines: [],
        status: 'pending_approval'
      };

      const approvals: AgentToolApprovalRequest[] = [];
      const decisions: Array<'approved' | 'rejected'> = [];
      const runtime = new ToolRuntime(
        failingWorkspaceBackend(),
        {
          async previewPatch() {
            return proposal;
          },
          async previewFileCreation() {
            throw new Error('not used');
          },
          async resolveApproval(proposalId: string, decision: 'approved' | 'rejected'): Promise<PatchApplyResult> {
            decisions.push(decision);
            return {
              proposalId,
              absolutePath: proposal.absolutePath,
              workspacePath: proposal.workspacePath,
              success: decision === 'approved',
              decision,
              message: decision === 'approved' ? 'Patch applied successfully.' : 'Patch rejected from the UI.'
            };
          }
        },
        failingTerminalBackend()
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-2',
          name: 'apply_patch',
          arguments: {
            workspacePath: proposal.workspacePath,
            searchBlock: proposal.searchBlock,
            replaceBlock: proposal.replaceBlock
          }
        },
        basePolicy,
        async (approval) => {
          approvals.push(approval);
          return 'approved';
        }
      );

      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]?.toolName, 'apply_patch');
      assert.equal(approvals[0]?.patchProposal?.proposalId, proposal.proposalId);
      assert.deepEqual(decisions, ['approved']);
      assert.equal(result.success, true);
      assert.equal(result.content, 'Patch applied successfully.');
    }
  },
  {
    name: 'create_file asks for approval and creates approved file',
    async run() {
      const proposal: PatchProposal = {
        proposalId: 'patch-create-1',
        absolutePath: 'C:/workspace/src/index.html',
        workspacePath: 'src/index.html',
        operation: 'create',
        replaceBlock: '<h1>Hello</h1>',
        unifiedDiff: '@@',
        diffLines: [
          {
            kind: 'add',
            lineNumberAfter: 1,
            text: '<h1>Hello</h1>'
          }
        ],
        status: 'pending_approval'
      };

      const approvals: AgentToolApprovalRequest[] = [];
      const decisions: Array<'approved' | 'rejected'> = [];
      const runtime = new ToolRuntime(
        failingWorkspaceBackend(),
        {
          async previewPatch() {
            throw new Error('not used');
          },
          async previewFileCreation() {
            return proposal;
          },
          async resolveApproval(proposalId: string, decision: 'approved' | 'rejected'): Promise<PatchApplyResult> {
            decisions.push(decision);
            return {
              proposalId,
              absolutePath: proposal.absolutePath,
              workspacePath: proposal.workspacePath,
              success: decision === 'approved',
              decision,
              message: decision === 'approved' ? 'File created successfully.' : 'File creation rejected from the UI.'
            };
          }
        },
        failingTerminalBackend()
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-create-1',
          name: 'create_file',
          arguments: {
            workspacePath: proposal.workspacePath,
            content: proposal.replaceBlock
          }
        },
        basePolicy,
        async (approval) => {
          approvals.push(approval);
          return 'approved';
        }
      );

      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]?.toolName, 'create_file');
      assert.equal(approvals[0]?.patchProposal?.operation, 'create');
      assert.deepEqual(decisions, ['approved']);
      assert.equal(result.success, true);
      assert.equal(result.content, 'File created successfully.');
    }
  },
  {
    name: 'apply_patch fails cleanly if approval handler is missing',
    async run() {
      const runtime = new ToolRuntime(
        failingWorkspaceBackend(),
        {
          async previewPatch() {
            return {
              proposalId: 'patch-2',
              absolutePath: 'C:/workspace/app.ts',
              workspacePath: 'src/app.ts',
              operation: 'replace',
              searchBlock: 'oldValue',
              replaceBlock: 'newValue',
              matchCount: 1,
              occurrence: 1,
              unifiedDiff: '@@',
              diffLines: [],
              status: 'pending_approval'
            };
          },
          async previewFileCreation() {
            throw new Error('not used');
          },
          async resolveApproval() {
            throw new Error('not used');
          }
        },
        failingTerminalBackend()
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-3',
          name: 'apply_patch',
          arguments: {
            workspacePath: 'src/app.ts',
            searchBlock: 'oldValue',
            replaceBlock: 'newValue'
          }
        },
        basePolicy
      );

      assert.equal(result.success, false);
      assert.match(result.content, /approval handler is available/);
    }
  },
  {
    name: 'create_file fails cleanly if approval handler is missing',
    async run() {
      const runtime = new ToolRuntime(
        failingWorkspaceBackend(),
        {
          async previewPatch() {
            throw new Error('not used');
          },
          async previewFileCreation() {
            return {
              proposalId: 'patch-create-2',
              absolutePath: 'C:/workspace/src/index.html',
              workspacePath: 'src/index.html',
              operation: 'create',
              replaceBlock: '<h1>Hello</h1>',
              unifiedDiff: '@@',
              diffLines: [],
              status: 'pending_approval'
            };
          },
          async resolveApproval() {
            throw new Error('not used');
          }
        },
        failingTerminalBackend()
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-create-2',
          name: 'create_file',
          arguments: {
            workspacePath: 'src/index.html',
            content: '<h1>Hello</h1>'
          }
        },
        basePolicy
      );

      assert.equal(result.success, false);
      assert.match(result.content, /approval handler is available/);
    }
  },
  {
    name: 'execute_terminal_command rejects when UI rejects approval',
    async run() {
      const approval: CommandApprovalRequest = {
        approvalId: 'cmd-approval-1',
        command: 'npm run lint',
        cwd: 'C:/workspace',
        allowlisted: false,
        status: 'pending_approval'
      };
      let started = false;

      const runtime = new ToolRuntime(
        failingWorkspaceBackend(),
        failingPatchBackend(),
        {
          prepareCommand() {
            return {
              kind: 'approval_required' as const,
              approval
            };
          },
          startApprovedCommand() {
            started = true;
            throw new Error('should not start');
          },
          async executeCommandAndWait() {
            throw new Error('should not execute');
          }
        }
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-4',
          name: 'execute_terminal_command',
          arguments: {
            command: approval.command,
            cwd: approval.cwd
          }
        },
        basePolicy,
        async () => 'rejected'
      );

      assert.equal(started, false);
      assert.equal(result.success, false);
      assert.equal(result.content, 'Terminal command rejected from the UI.');
    }
  },
  {
    name: 'execute_terminal_command starts approved command and returns captured result',
    async run() {
      const approval: CommandApprovalRequest = {
        approvalId: 'cmd-approval-2',
        command: 'npm test',
        cwd: 'C:/workspace',
        allowlisted: true,
        status: 'pending_approval'
      };
      let startedWith: CommandApprovalRequest | undefined;
      let executedRunId = '';

      const runtime = new ToolRuntime(
        failingWorkspaceBackend(),
        failingPatchBackend(),
        {
          prepareCommand() {
            return {
              kind: 'approval_required' as const,
              approval
            };
          },
          startApprovedCommand(currentApproval) {
            startedWith = currentApproval;
            return {
              runId: currentApproval.approvalId,
              command: currentApproval.command,
              cwd: currentApproval.cwd,
              status: 'running',
              startedAt: '2026-04-09T00:00:00.000Z',
              stdout: '',
              stderr: ''
            };
          },
          async executeCommandAndWait(run) {
            executedRunId = run.runId;
            return {
              ...run,
              status: 'completed',
              endedAt: '2026-04-09T00:00:01.000Z',
              exitCode: 0,
              stdout: 'ok',
              stderr: ''
            };
          }
        }
      );

      const result = await runtime.executeToolCall(
        {
          id: 'tool-5',
          name: 'execute_terminal_command',
          arguments: {
            command: approval.command,
            cwd: approval.cwd
          }
        },
        basePolicy,
        async () => 'approved'
      );

      assert.equal(startedWith?.approvalId, approval.approvalId);
      assert.equal(executedRunId, approval.approvalId);
      assert.equal(result.success, true);
      assert.deepEqual(result.structuredContent, {
        exitCode: 0,
        status: 'completed'
      });
      assert.match(result.content, /"stdout": "ok"/);
    }
  }
];

function failingWorkspaceBackend() {
  return {
    async readFile(): Promise<WorkspaceFileReadResult> {
      throw new Error('workspace backend should not be used in this test');
    },
    async searchWorkspace(): Promise<WorkspaceSearchResult> {
      throw new Error('workspace backend should not be used in this test');
    }
  };
}

function failingPatchBackend() {
  return {
    async previewPatch(): Promise<PatchProposal> {
      throw new Error('patch backend should not be used in this test');
    },
    async previewFileCreation(): Promise<PatchProposal> {
      throw new Error('patch backend should not be used in this test');
    },
    async resolveApproval(): Promise<PatchApplyResult> {
      throw new Error('patch backend should not be used in this test');
    }
  };
}

function failingTerminalBackend() {
  return {
    prepareCommand() {
      throw new Error('terminal backend should not be used in this test');
    },
    startApprovedCommand() {
      throw new Error('terminal backend should not be used in this test');
    },
    async executeCommandAndWait(): Promise<CommandRunRecord> {
      throw new Error('terminal backend should not be used in this test');
    }
  };
}
