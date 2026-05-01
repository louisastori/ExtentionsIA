import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  ActiveEditorContext,
  ProjectMemorySnapshot,
  WorkspaceFileReadResult,
  WorkspaceSearchMatch,
  WorkspaceSearchResult
} from '../types';

const ACTIVE_EDITOR_SELECTION_PADDING_LINES = 4;
const ACTIVE_EDITOR_CURSOR_PADDING_LINES = 12;
const ACTIVE_EDITOR_MAX_EXCERPT_CHARS = 4000;
const ACTIVE_EDITOR_MAX_SELECTION_CHARS = 1800;
const ACTIVE_EDITOR_MAX_LINE_LENGTH = 220;
const PROJECT_MEMORY_MAX_DESCRIPTION_LENGTH = 420;
const PROJECT_MEMORY_MAX_SCRIPTS = 16;

const PROJECT_MARKER_FILES = [
  'package.json',
  'README.md',
  'readme.md',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json'
];

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

  public buildProjectMemory(): ProjectMemorySnapshot | undefined {
    const workspaceFolders = this.getWorkspaceFolders();
    if (workspaceFolders.length === 0) {
      return undefined;
    }

    const techStack = new Set<string>();
    const packageScripts = new Set<string>();
    const importantFiles = new Set<string>();
    const fingerprintParts: string[] = [];
    let displayName: string | undefined;
    let description: string | undefined;
    let newestMarkerMtime = 0;

    for (const workspaceFolder of workspaceFolders) {
      const folderName = path.basename(workspaceFolder);
      const workspacePrefix = workspaceFolders.length > 1 ? `${folderName}/` : '';
      const packageJsonPath = path.join(workspaceFolder, 'package.json');
      const packageJson = readJsonFile(packageJsonPath);

      if (packageJson) {
        importantFiles.add(`${workspacePrefix}package.json`);
        displayName ??=
          getStringProperty(packageJson, 'displayName') ??
          getStringProperty(packageJson, 'name') ??
          folderName;
        description ??= getStringProperty(packageJson, 'description');
        collectPackageTechStack(packageJson, techStack);

        for (const scriptName of Object.keys(getRecordProperty(packageJson, 'scripts') ?? {}).slice(0, PROJECT_MEMORY_MAX_SCRIPTS)) {
          packageScripts.add(scriptName);
        }
      }

      description ??= readReadmeSummary(workspaceFolder);

      for (const markerFile of PROJECT_MARKER_FILES) {
        const absoluteMarkerPath = path.join(workspaceFolder, markerFile);
        const stat = statIfExists(absoluteMarkerPath);
        if (!stat) {
          continue;
        }

        newestMarkerMtime = Math.max(newestMarkerMtime, stat.mtimeMs);
        fingerprintParts.push(`${path.resolve(absoluteMarkerPath)}:${stat.mtimeMs}:${stat.size}`);
        importantFiles.add(`${workspacePrefix}${markerFile}`);
        collectMarkerTechStack(markerFile, techStack);
      }
    }

    const fallbackDisplayName =
      workspaceFolders.length === 1
        ? path.basename(workspaceFolders[0])
        : workspaceFolders.map((workspaceFolder) => path.basename(workspaceFolder)).join(', ');

    return {
      fingerprint:
        fingerprintParts.length > 0
          ? fingerprintParts.sort().join('|')
          : workspaceFolders.map((workspaceFolder) => path.resolve(workspaceFolder)).join('|'),
      displayName: shortenText(displayName ?? fallbackDisplayName, 120),
      workspaceFolders: workspaceFolders.map((workspaceFolder) => path.basename(workspaceFolder)),
      description: description ? shortenText(description, PROJECT_MEMORY_MAX_DESCRIPTION_LENGTH) : undefined,
      techStack: [...techStack].sort(),
      packageScripts: [...packageScripts].sort(),
      importantFiles: [...importantFiles].sort(),
      updatedAt: new Date(newestMarkerMtime || Date.now()).toISOString()
    };
  }

  public getActiveEditorContext(): ActiveEditorContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }

    const document = editor.document;
    if (document.uri.scheme !== 'file') {
      return undefined;
    }

    let absolutePath: string;
    try {
      absolutePath = this.assertPathWithinWorkspace(document.uri.fsPath);
    } catch {
      return undefined;
    }

    const workspacePath = this.toWorkspacePath(absolutePath);
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;
    const focusStartLine = hasSelection ? selection.start.line : selection.active.line;
    const focusEndLine = hasSelection ? selection.end.line : selection.active.line;
    const excerptPadding = hasSelection ? ACTIVE_EDITOR_SELECTION_PADDING_LINES : ACTIVE_EDITOR_CURSOR_PADDING_LINES;
    const excerptStartLine = Math.max(0, focusStartLine - excerptPadding);
    const excerptEndLine = Math.min(document.lineCount - 1, focusEndLine + excerptPadding);
    const excerptRange = new vscode.Range(
      excerptStartLine,
      0,
      excerptEndLine,
      document.lineAt(excerptEndLine).range.end.character
    );

    return {
      absolutePath,
      workspacePath,
      languageId: document.languageId,
      isDirty: document.isDirty,
      lineCount: document.lineCount,
      cursorLine: selection.active.line + 1,
      cursorCharacter: selection.active.character + 1,
      focusStartLine: focusStartLine + 1,
      focusEndLine: focusEndLine + 1,
      excerptStartLine: excerptStartLine + 1,
      excerptEndLine: excerptEndLine + 1,
      excerpt: capText(document.getText(excerptRange), ACTIVE_EDITOR_MAX_EXCERPT_CHARS),
      selection: hasSelection
        ? {
            startLine: selection.start.line + 1,
            startCharacter: selection.start.character + 1,
            endLine: selection.end.line + 1,
            endCharacter: selection.end.character + 1,
            text: capText(document.getText(selection), ACTIVE_EDITOR_MAX_SELECTION_CHARS)
          }
        : undefined
    };
  }
}

export function formatActiveEditorContext(context: ActiveEditorContext): string {
  const sections = [
    'Contexte automatique de l editeur actif dans VS Code.',
    `- Fichier actif: ${context.workspacePath}`,
    `- Langage: ${context.languageId}`,
    `- Etat: ${context.isDirty ? 'modifie non sauvegarde' : 'sauvegarde'}`,
    `- Curseur: ligne ${context.cursorLine}, colonne ${context.cursorCharacter}`
  ];

  if (context.selection) {
    sections.push(
      `- Selection: lignes ${context.selection.startLine}-${context.selection.endLine}, colonnes ${context.selection.startCharacter}-${context.selection.endCharacter}`
    );
    if (context.selection.text.trim().length > 0) {
      sections.push('Selection exacte:');
      sections.push(context.selection.text);
    }
  } else {
    sections.push(`- Zone de focus: lignes ${context.focusStartLine}-${context.focusEndLine}`);
  }

  sections.push(`- Extrait autour du curseur ou de la selection (lignes ${context.excerptStartLine}-${context.excerptEndLine}):`);
  sections.push(formatExcerptWithLineNumbers(context.excerpt, context.excerptStartLine));

  return sections.join('\n');
}

function normalizeUserPath(inputPath: string): string {
  return inputPath.replace(/[\\/]+/g, path.sep);
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readReadmeSummary(workspaceFolder: string): string | undefined {
  const readmePath = ['README.md', 'readme.md']
    .map((fileName) => path.join(workspaceFolder, fileName))
    .find((candidate) => fs.existsSync(candidate));

  if (!readmePath) {
    return undefined;
  }

  let content: string;
  try {
    content = fs.readFileSync(readmePath, 'utf8');
  } catch {
    return undefined;
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const summaryLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (summaryLines.length > 0) {
        break;
      }
      continue;
    }

    if (line.startsWith('#') || line.startsWith('```')) {
      continue;
    }

    summaryLines.push(line.replace(/^[-*]\s+/, ''));
  }

  return summaryLines.length > 0 ? shortenText(summaryLines.join(' '), PROJECT_MEMORY_MAX_DESCRIPTION_LENGTH) : undefined;
}

function collectPackageTechStack(packageJson: Record<string, unknown>, techStack: Set<string>): void {
  const dependencies = {
    ...(getRecordProperty(packageJson, 'dependencies') ?? {}),
    ...(getRecordProperty(packageJson, 'devDependencies') ?? {})
  };

  techStack.add('Node.js');

  if (getRecordProperty(packageJson, 'contributes') || getRecordProperty(packageJson, 'engines')?.vscode) {
    techStack.add('VS Code extension');
  }
  if ('typescript' in dependencies) {
    techStack.add('TypeScript');
  }
  if ('react' in dependencies) {
    techStack.add('React');
  }
  if ('vite' in dependencies || getRecordProperty(packageJson, 'devDependencies')?.vite) {
    techStack.add('Vite');
  }
  if ('eslint' in dependencies || '@typescript-eslint/parser' in dependencies) {
    techStack.add('ESLint');
  }
}

function collectMarkerTechStack(markerFile: string, techStack: Set<string>): void {
  switch (markerFile) {
    case 'tsconfig.json':
      techStack.add('TypeScript');
      return;
    case 'vite.config.ts':
    case 'vite.config.js':
      techStack.add('Vite');
      return;
    case 'pyproject.toml':
    case 'requirements.txt':
      techStack.add('Python');
      return;
    case 'Cargo.toml':
      techStack.add('Rust');
      return;
    case 'go.mod':
      techStack.add('Go');
      return;
    case 'pom.xml':
    case 'build.gradle':
      techStack.add('Java');
      return;
    case 'composer.json':
      techStack.add('PHP');
      return;
    default:
      return;
  }
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const property = value[key];
  return typeof property === 'string' && property.trim().length > 0 ? property.trim() : undefined;
}

function getRecordProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const property = value[key];
  return isObject(property) ? property : undefined;
}

function statIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getLineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return content.split(/\r?\n/).length;
}

function capText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, '\n');
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatExcerptWithLineNumbers(excerpt: string, startLine: number): string {
  const lines = excerpt.replace(/\r\n/g, '\n').split('\n');
  return lines
    .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${shortenLine(line)}`)
    .join('\n');
}

function shortenLine(value: string): string {
  if (value.length <= ACTIVE_EDITOR_MAX_LINE_LENGTH) {
    return value;
  }

  return `${value.slice(0, ACTIVE_EDITOR_MAX_LINE_LENGTH - 3)}...`;
}

function shortenText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
