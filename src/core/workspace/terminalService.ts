import { spawn, type ChildProcess } from 'child_process';
import { createId } from '../protocol/messages';
import type {
  CommandApprovalRequest,
  CommandExecutionRequest,
  CommandRunRecord,
  CommandStreamEvent,
  TerminalPolicySnapshot
} from '../types';
import { WorkspaceService } from './workspaceService';

export interface CommandStartDecision {
  kind: 'approval_required' | 'start_now';
  approval?: CommandApprovalRequest;
  run?: CommandRunRecord;
}

export class TerminalService {
  private readonly runningProcesses = new Map<string, ChildProcess>();

  public constructor(private readonly workspaceService: WorkspaceService) {}

  public prepareCommand(
    request: CommandExecutionRequest,
    policy: TerminalPolicySnapshot
  ): CommandStartDecision {
    const command = request.command.trim();
    if (command.length === 0) {
      throw new Error('Command cannot be empty.');
    }

    const cwd = this.resolveCwd(request.cwd);
    this.assertCommandAllowed(command, policy);
    const allowlisted = matchesAny(command, policy.commandAllowList);

    if (policy.autoApproveTerminal || allowlisted) {
      return {
        kind: 'start_now',
        run: createCommandRun({
          runId: createId('cmd'),
          command,
          cwd,
          label: request.label,
          status: 'running'
        })
      };
    }

    return {
      kind: 'approval_required',
      approval: {
        approvalId: createId('cmd-approval'),
        command,
        cwd,
        label: request.label,
        allowlisted,
        status: 'pending_approval'
      }
    };
  }

  public startApprovedCommand(approval: CommandApprovalRequest): CommandRunRecord {
    return createCommandRun({
      runId: approval.approvalId,
      command: approval.command,
      cwd: approval.cwd,
      label: approval.label,
      status: 'running'
    });
  }

  public executeCommand(
    run: CommandRunRecord,
    callbacks: {
      onStream: (event: CommandStreamEvent) => void;
      onFinish: (result: CommandRunRecord) => void;
    }
  ): void {
    const child = spawn(run.command, {
      cwd: run.cwd,
      shell: true,
      env: process.env
    });

    this.runningProcesses.set(run.runId, child);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string | Buffer) => {
      callbacks.onStream({
        runId: run.runId,
        stream: 'stdout',
        textDelta: chunk.toString()
      });
    });

    child.stderr?.on('data', (chunk: string | Buffer) => {
      callbacks.onStream({
        runId: run.runId,
        stream: 'stderr',
        textDelta: chunk.toString()
      });
    });

    child.on('error', (error) => {
      this.runningProcesses.delete(run.runId);
      callbacks.onFinish({
        ...run,
        status: 'failed',
        endedAt: new Date().toISOString(),
        exitCode: null,
        stderr: appendBounded(run.stderr, error.message)
      });
    });

    child.on('close', (exitCode, signal) => {
      this.runningProcesses.delete(run.runId);
      callbacks.onFinish({
        ...run,
        status: signal ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed',
        endedAt: new Date().toISOString(),
        exitCode
      });
    });
  }

  public executeCommandAndWait(
    run: CommandRunRecord,
    callbacks?: {
      onStream?: (event: CommandStreamEvent) => void;
    }
  ): Promise<CommandRunRecord> {
    return new Promise((resolve) => {
      let currentRun = { ...run };

      this.executeCommand(run, {
        onStream: (event) => {
          currentRun = {
            ...currentRun,
            [event.stream]: appendBounded(currentRun[event.stream], event.textDelta)
          };
          callbacks?.onStream?.(event);
        },
        onFinish: (result) => {
          resolve({
            ...result,
            stdout: currentRun.stdout,
            stderr: currentRun.stderr
          });
        }
      });
    });
  }

  public stopCommand(runId: string): boolean {
    const process = this.runningProcesses.get(runId);
    if (!process) {
      return false;
    }

    this.runningProcesses.delete(runId);
    process.kill();
    return true;
  }

  public stopAllCommands(): string[] {
    const runIds = [...this.runningProcesses.keys()];
    for (const runId of runIds) {
      this.stopCommand(runId);
    }

    return runIds;
  }

  private resolveCwd(inputCwd?: string): string {
    const workspaceFolders = this.workspaceService.getWorkspaceFolders();
    if (inputCwd?.trim()) {
      return this.workspaceService.assertPathWithinWorkspace(inputCwd.trim());
    }

    if (!workspaceFolders[0]) {
      throw new Error('No workspace folder is open.');
    }

    return workspaceFolders[0];
  }

  private assertCommandAllowed(command: string, policy: TerminalPolicySnapshot): void {
    if (matchesAny(command, policy.commandDenyList)) {
      throw new Error(`Command blocked by deny list: ${command}`);
    }
  }
}

function createCommandRun(input: {
  runId: string;
  command: string;
  cwd: string;
  label?: string;
  status: CommandRunRecord['status'];
}): CommandRunRecord {
  return {
    runId: input.runId,
    command: input.command,
    cwd: input.cwd,
    label: input.label,
    status: input.status,
    startedAt: new Date().toISOString(),
    stdout: '',
    stderr: ''
  };
}

function matchesAny(command: string, entries: string[]): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  return entries.some((entry) => normalizedCommand === entry.trim().toLowerCase());
}

function appendBounded(currentValue: string, nextChunk: string): string {
  const merged = `${currentValue}${nextChunk}`;
  const maxLength = 100000;
  if (merged.length <= maxLength) {
    return merged;
  }

  return merged.slice(merged.length - maxLength);
}
