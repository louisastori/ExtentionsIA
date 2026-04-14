import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceFileReadResult, WorkspaceSearchMatch, WorkspaceSearchResult } from '../types';

export class WorkspaceService {
  public getWorkspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  public hasWorkspace(): boolean {
    return this.getWorkspaceFolders().length > 0;
  }

  public assertPathWithinWorkspace(absolutePath: string): string {
    if (!this.hasWorkspace()) {
      throw new Error('No workspace folder is open.');
    }

    const normalizedPath = path.resolve(absolutePath);
    const normalizedPathLower = normalizedPath.toLowerCase();

    const isAllowed = this.getWorkspaceFolders().some((workspaceFolder) => {
      const normalizedWorkspace = path.resolve(workspaceFolder);
      const normalizedWorkspaceLower = normalizedWorkspace.toLowerCase();
      return (
        normalizedPathLower === normalizedWorkspaceLower ||
        normalizedPathLower.startsWith(`${normalizedWorkspaceLower}${path.sep}`)
      );
    });

    if (!isAllowed) {
      throw new Error('Path is outside the current workspace.');
    }

    return normalizedPath;
  }

  public resolveWorkspacePath(inputPath: string, options?: { allowMissing?: boolean }): string {
    if (!this.hasWorkspace()) {
      throw new Error('No workspace folder is open.');
    }

    const trimmedPath = inputPath.trim();
    if (trimmedPath.length === 0) {
      throw new Error('Workspace path cannot be empty.');
    }

    if (path.isAbsolute(trimmedPath)) {
      return this.assertPathWithinWorkspace(trimmedPath);
    }

    const workspaceFolders = this.getWorkspaceFolders();
    if (workspaceFolders.length === 1) {
      return this.assertPathWithinWorkspace(path.resolve(workspaceFolders[0], trimmedPath));
    }

    const normalizedRelativePath = normalizeUserPath(trimmedPath);
    const firstSegment = normalizedRelativePath.split(path.sep)[0]?.toLowerCase();
    const prefixedWorkspace = workspaceFolders.find(
      (workspaceFolder) => path.basename(workspaceFolder).toLowerCase() === firstSegment
    );

    if (prefixedWorkspace) {
      const withoutPrefix = normalizedRelativePath.split(path.sep).slice(1).join(path.sep);
      return this.assertPathWithinWorkspace(path.resolve(prefixedWorkspace, withoutPrefix));
    }

    const existingCandidates = workspaceFolders
      .map((workspaceFolder) => path.resolve(workspaceFolder, normalizedRelativePath))
      .filter((candidate) => fs.existsSync(candidate));

    if (existingCandidates.length === 1) {
      return this.assertPathWithinWorkspace(existingCandidates[0]);
    }

    if (options?.allowMissing) {
      throw new Error(
        'Multiple workspace folders are open. Prefix the path with the workspace folder name for new files.'
      );
    }

    throw new Error(
      'Multiple workspace folders are open. Prefix the path with the workspace folder name.'
    );
  }

  public toWorkspacePath(absolutePath: string): string {
    const normalizedPath = this.assertPathWithinWorkspace(absolutePath);
    const workspaceFolders = this.getWorkspaceFolders();
    const workspaceRoot = workspaceFolders.find((workspaceFolder) => {
      const normalizedWorkspace = path.resolve(workspaceFolder);
      const normalizedWorkspaceLower = normalizedWorkspace.toLowerCase();
      const normalizedPathLower = normalizedPath.toLowerCase();

      return (
        normalizedPathLower === normalizedWorkspaceLower ||
        normalizedPathLower.startsWith(`${normalizedWorkspaceLower}${path.sep}`)
      );
    });

    if (!workspaceRoot) {
      throw new Error('Path is outside the current workspace.');
    }

    const relativePath = path.relative(workspaceRoot, normalizedPath);
    if (workspaceFolders.length === 1) {
      return relativePath;
    }

    return path.join(path.basename(workspaceRoot), relativePath);
  }

  public async readFile(inputPath: string): Promise<WorkspaceFileReadResult> {
    const normalizedPath = this.resolveWorkspacePath(inputPath);
    const uri = vscode.Uri.file(normalizedPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString('utf8');

    return {
      absolutePath: normalizedPath,
      workspacePath: this.toWorkspacePath(normalizedPath),
      content,
      lineCount: getLineCount(content),
      sizeBytes: bytes.byteLength
    };
  }

  public async searchWorkspace(pattern: string, maxResults = 50): Promise<WorkspaceSearchResult> {
    const trimmedPattern = pattern.trim();
    if (trimmedPattern.length === 0) {
      throw new Error('Search pattern cannot be empty.');
    }

    const matches: WorkspaceSearchMatch[] = [];
    const candidateFiles = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/out/**,**/media/webview/**}',
      Math.max(maxResults * 10, 200)
    );

    for (const file of candidateFiles) {
      if (matches.length >= maxResults) {
        break;
      }

      const bytes = await vscode.workspace.fs.readFile(file);
      const content = Buffer.from(bytes).toString('utf8');
      if (content.includes('\u0000')) {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (matches.length >= maxResults) {
          break;
        }

        const lineText = lines[lineIndex];
        const haystack = lineText.toLowerCase();
        const needle = trimmedPattern.toLowerCase();
        let searchOffset = 0;

        while (matches.length < maxResults) {
          const foundIndex = haystack.indexOf(needle, searchOffset);
          if (foundIndex === -1) {
            break;
          }

          matches.push({
            absolutePath: file.fsPath,
            workspacePath: this.toWorkspacePath(file.fsPath),
            lineNumber: lineIndex + 1,
            startColumn: foundIndex + 1,
            endColumn: foundIndex + needle.length + 1,
            lineText
          });
          searchOffset = foundIndex + Math.max(needle.length, 1);
        }
      }
    }

    return {
      pattern: trimmedPattern,
      matches,
      totalMatches: matches.length,
      truncated: matches.length >= maxResults
    };
  }
}

function normalizeUserPath(inputPath: string): string {
  return inputPath.replace(/[\\/]+/g, path.sep);
}

function getLineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return content.split(/\r?\n/).length;
}
