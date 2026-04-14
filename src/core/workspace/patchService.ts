import * as path from 'path';
import * as vscode from 'vscode';
import { createId } from '../protocol/messages';
import type { DiffLine, PatchApplyResult, PatchProposal, WorkspaceFileReadResult } from '../types';
import { WorkspaceService } from './workspaceService';

interface PatchPreviewInput {
  workspacePath: string;
  searchBlock: string;
  replaceBlock: string;
  occurrence?: number;
}

interface FileCreationPreviewInput {
  workspacePath: string;
  content: string;
}

interface StoredPatchProposal {
  proposal: PatchProposal;
  originalContent?: string;
}

export class PatchService {
  private readonly proposals = new Map<string, StoredPatchProposal>();

  public constructor(private readonly workspaceService: WorkspaceService) {}

  public async previewPatch(input: PatchPreviewInput): Promise<PatchProposal> {
    const searchBlock = input.searchBlock;
    if (searchBlock.length === 0) {
      throw new Error('searchBlock cannot be empty.');
    }

    const file = await this.workspaceService.readFile(input.workspacePath);
    const matches = findAllOccurrences(file.content, searchBlock);
    if (matches.length === 0) {
      throw new Error('The search block was not found in the target file.');
    }

    const occurrence = input.occurrence ?? (matches.length === 1 ? 1 : 0);
    if (occurrence === 0) {
      throw new Error('Multiple matches found. Specify the occurrence to patch.');
    }

    if (occurrence < 1 || occurrence > matches.length) {
      throw new Error(`Occurrence ${occurrence} is out of range. Found ${matches.length} matches.`);
    }

    const targetMatch = matches[occurrence - 1];
    const proposalId = createId('patch');
    const proposal: PatchProposal = {
      proposalId,
      absolutePath: file.absolutePath,
      workspacePath: file.workspacePath,
      operation: 'replace',
      searchBlock,
      replaceBlock: input.replaceBlock,
      matchCount: matches.length,
      occurrence,
      unifiedDiff: buildUnifiedDiff(file.content, targetMatch.startIndex, searchBlock, input.replaceBlock),
      diffLines: buildDiffLines(file.content, targetMatch.startIndex, searchBlock, input.replaceBlock),
      status: 'pending_approval'
    };

    this.proposals.set(proposalId, {
      proposal,
      originalContent: file.content
    });

    return proposal;
  }

  public async previewFileCreation(input: FileCreationPreviewInput): Promise<PatchProposal> {
    const absolutePath = this.workspaceService.resolveWorkspacePath(input.workspacePath, { allowMissing: true });
    if (await fileExists(absolutePath)) {
      throw new Error('The target file already exists. Use apply_patch to edit it.');
    }

    const proposalId = createId('patch');
    const proposal: PatchProposal = {
      proposalId,
      absolutePath,
      workspacePath: this.workspaceService.toWorkspacePath(absolutePath),
      operation: 'create',
      replaceBlock: input.content,
      unifiedDiff: buildCreateUnifiedDiff(input.content),
      diffLines: buildCreateDiffLines(input.content),
      status: 'pending_approval'
    };

    this.proposals.set(proposalId, {
      proposal
    });

    return proposal;
  }

  public async resolveApproval(
    proposalId: string,
    decision: 'approved' | 'rejected'
  ): Promise<PatchApplyResult> {
    const storedProposal = this.proposals.get(proposalId);
    if (!storedProposal) {
      throw new Error('Unknown patch proposal.');
    }

    this.proposals.delete(proposalId);

    if (decision === 'rejected') {
      return {
        proposalId,
        absolutePath: storedProposal.proposal.absolutePath,
        workspacePath: storedProposal.proposal.workspacePath,
        success: false,
        decision,
        message:
          storedProposal.proposal.operation === 'create'
            ? 'File creation rejected from the UI.'
            : 'Patch rejected from the UI.'
      };
    }

    if (storedProposal.proposal.operation === 'create') {
      if (await fileExists(storedProposal.proposal.absolutePath)) {
        return {
          proposalId,
          absolutePath: storedProposal.proposal.absolutePath,
          workspacePath: storedProposal.proposal.workspacePath,
          success: false,
          decision,
          message: 'The target file now exists. Create a new file creation proposal.'
        };
      }

      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(storedProposal.proposal.absolutePath)));
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(storedProposal.proposal.absolutePath),
        Buffer.from(storedProposal.proposal.replaceBlock, 'utf8')
      );

      const createdFile = await this.workspaceService.readFile(storedProposal.proposal.absolutePath);
      return {
        proposalId,
        absolutePath: createdFile.absolutePath,
        workspacePath: createdFile.workspacePath,
        success: true,
        decision,
        message: 'File created successfully.',
        updatedFile: createdFile
      };
    }

    const currentFile = await this.workspaceService.readFile(storedProposal.proposal.absolutePath);
    if (currentFile.content !== storedProposal.originalContent) {
      return {
        proposalId,
        absolutePath: currentFile.absolutePath,
        workspacePath: currentFile.workspacePath,
        success: false,
        decision,
        message: 'The file changed after the preview. Create a new patch preview.'
      };
    }

    const searchBlock = storedProposal.proposal.searchBlock ?? '';
    const occurrence = storedProposal.proposal.occurrence ?? 0;
    if (searchBlock.length === 0 || occurrence < 1) {
      return {
        proposalId,
        absolutePath: currentFile.absolutePath,
        workspacePath: currentFile.workspacePath,
        success: false,
        decision,
        message: 'The stored patch proposal is invalid. Create a new patch preview.'
      };
    }

    const matches = findAllOccurrences(currentFile.content, searchBlock);
    if (matches.length < occurrence) {
      return {
        proposalId,
        absolutePath: currentFile.absolutePath,
        workspacePath: currentFile.workspacePath,
        success: false,
        decision,
        message: 'The target block is no longer available at the expected occurrence.'
      };
    }

    const targetMatch = matches[occurrence - 1];
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      vscode.Uri.file(currentFile.absolutePath),
      new vscode.Range(
        positionAt(currentFile.content, targetMatch.startIndex),
        positionAt(currentFile.content, targetMatch.startIndex + searchBlock.length)
      ),
      storedProposal.proposal.replaceBlock
    );

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return {
        proposalId,
        absolutePath: currentFile.absolutePath,
        workspacePath: currentFile.workspacePath,
        success: false,
        decision,
        message: 'VS Code refused to apply the patch.'
      };
    }

    const updatedFile = await this.workspaceService.readFile(currentFile.absolutePath);
    return {
      proposalId,
      absolutePath: currentFile.absolutePath,
      workspacePath: currentFile.workspacePath,
      success: true,
      decision,
      message: 'Patch applied successfully.',
      updatedFile
    };
  }
}

function findAllOccurrences(content: string, searchBlock: string): Array<{ startIndex: number }> {
  const matches: Array<{ startIndex: number }> = [];
  let offset = 0;

  while (offset <= content.length) {
    const foundIndex = content.indexOf(searchBlock, offset);
    if (foundIndex === -1) {
      break;
    }

    matches.push({ startIndex: foundIndex });
    offset = foundIndex + Math.max(searchBlock.length, 1);
  }

  return matches;
}

function buildUnifiedDiff(content: string, startIndex: number, searchBlock: string, replaceBlock: string): string {
  const startLine = positionAt(content, startIndex).line + 1;
  const searchLines = normalizeLines(searchBlock);
  const replaceLines = normalizeLines(replaceBlock);
  const diffParts = [
    `--- ${startLine}`,
    `+++ ${startLine}`,
    `@@ -${startLine},${Math.max(searchLines.length, 1)} +${startLine},${Math.max(replaceLines.length, 1)} @@`
  ];

  for (const line of searchLines) {
    diffParts.push(`-${line}`);
  }

  for (const line of replaceLines) {
    diffParts.push(`+${line}`);
  }

  return diffParts.join('\n');
}

function buildDiffLines(content: string, startIndex: number, searchBlock: string, replaceBlock: string): DiffLine[] {
  const contextRadius = 3;
  const beforeLines = normalizeLines(content.slice(0, startIndex));
  const startLineNumber = beforeLines.length;
  const contextBefore = beforeLines.slice(Math.max(0, beforeLines.length - contextRadius));
  const searchLines = normalizeLines(searchBlock);
  const replaceLines = normalizeLines(replaceBlock);
  const afterLines = normalizeLines(content.slice(startIndex + searchBlock.length)).slice(0, contextRadius);

  const diffLines: DiffLine[] = [];

  contextBefore.forEach((line, index) => {
    const lineNumber = startLineNumber - contextBefore.length + index + 1;
    diffLines.push({
      kind: 'context',
      lineNumberBefore: lineNumber,
      lineNumberAfter: lineNumber,
      text: line
    });
  });

  searchLines.forEach((line, index) => {
    diffLines.push({
      kind: 'remove',
      lineNumberBefore: startLineNumber + index + 1,
      text: line
    });
  });

  replaceLines.forEach((line, index) => {
    diffLines.push({
      kind: 'add',
      lineNumberAfter: startLineNumber + index + 1,
      text: line
    });
  });

  afterLines.forEach((line, index) => {
    diffLines.push({
      kind: 'context',
      lineNumberBefore: startLineNumber + searchLines.length + index + 1,
      lineNumberAfter: startLineNumber + replaceLines.length + index + 1,
      text: line
    });
  });

  return diffLines;
}

function buildCreateUnifiedDiff(content: string): string {
  const lines = normalizeLines(content);
  const diffParts = ['--- /dev/null', '+++ new-file', `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`];

  for (const line of lines) {
    diffParts.push(`+${line}`);
  }

  return diffParts.join('\n');
}

function buildCreateDiffLines(content: string): DiffLine[] {
  return normalizeLines(content).map((line, index) => ({
    kind: 'add',
    lineNumberAfter: index + 1,
    text: line
  }));
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
    return true;
  } catch {
    return false;
  }
}

function normalizeLines(text: string): string[] {
  if (text.length === 0) {
    return [''];
  }

  return text.replace(/\r\n/g, '\n').split('\n');
}

function positionAt(content: string, index: number): vscode.Position {
  let line = 0;
  let character = 0;

  for (let offset = 0; offset < index; offset += 1) {
    if (content[offset] === '\n') {
      line += 1;
      character = 0;
    } else if (content[offset] !== '\r') {
      character += 1;
    }
  }

  return new vscode.Position(line, character);
}

export function toWorkspaceFileReadResult(file: WorkspaceFileReadResult): WorkspaceFileReadResult {
  return file;
}
