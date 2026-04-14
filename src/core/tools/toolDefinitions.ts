import type { CanonicalToolDefinition } from '../types';

export const canonicalToolDefinitions: CanonicalToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the full text content of a file inside the current workspace.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspacePath'],
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Path of the file relative to the workspace root.'
        }
      }
    }
  },
  {
    name: 'search_workspace',
    description: 'Search a text pattern across files in the current workspace.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          description: 'Plain text pattern to find.'
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of matches to return.'
        }
      }
    }
  },
  {
    name: 'create_file',
    description: 'Create a new file inside the current workspace with the provided text content.',
    riskLevel: 'medium',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspacePath', 'content'],
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Path of the new file relative to the workspace root.'
        },
        content: {
          type: 'string',
          description: 'Full text content to write into the new file.'
        }
      }
    }
  },
  {
    name: 'apply_patch',
    description: 'Replace an exact code block inside a workspace file.',
    riskLevel: 'medium',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspacePath', 'searchBlock', 'replaceBlock'],
      properties: {
        workspacePath: {
          type: 'string'
        },
        searchBlock: {
          type: 'string'
        },
        replaceBlock: {
          type: 'string'
        },
        occurrence: {
          type: 'integer',
          minimum: 1
        }
      }
    }
  },
  {
    name: 'execute_terminal_command',
    description: 'Run a shell command inside the current workspace and capture stdout, stderr and exit code.',
    riskLevel: 'high',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: {
          type: 'string'
        },
        cwd: {
          type: 'string'
        },
        label: {
          type: 'string'
        }
      }
    }
  },
  {
    name: 'complete_task',
    description: 'Signal that the task is complete and provide a final summary.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: {
        summary: {
          type: 'string'
        }
      }
    }
  }
];
