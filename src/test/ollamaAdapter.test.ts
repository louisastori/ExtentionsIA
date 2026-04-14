import assert from 'node:assert/strict';
import * as http from 'node:http';
import { OllamaAdapter } from '../core/providers/adapters/ollamaAdapter';
import type { ProviderToolExecutionContext } from '../core/types';
import type { TestCase } from './toolRuntime.test';

export const ollamaAdapterTests: TestCase[] = [
  {
    name: 'ollama adapter parses stringified tool arguments and preserves tool message fields',
    async run() {
      let capturedBody: Record<string, unknown> | undefined;
      const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on('end', () => {
          capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              message: {
                content: '',
                tool_calls: [
                  {
                    function: {
                      name: 'complete_task',
                      arguments: '{"summary":"site cree"}'
                    }
                  }
                ]
              }
            })
          );
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      try {
        const adapter = new OllamaAdapter();
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Unable to resolve test server address.');
        }

        const request: ProviderToolExecutionContext = {
          profile: {
            id: 'ollama-test',
            label: 'Ollama Test',
            providerType: 'ollama',
            baseUrl: `http://127.0.0.1:${address.port}`,
            model: 'qwen3'
          },
          model: 'qwen3',
          messages: [
            {
              role: 'system',
              content: 'You are a test agent.'
            },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'tool-1',
                  name: 'read_file',
                  arguments: {
                    workspacePath: 'src/index.html'
                  }
                }
              ]
            },
            {
              role: 'tool',
              name: 'read_file',
              toolCallId: 'tool-1',
              content: '<html></html>'
            }
          ],
          tools: [
            {
              name: 'complete_task',
              description: 'Finish the task.',
              riskLevel: 'low',
              inputSchema: {
                type: 'object',
                required: ['summary'],
                properties: {
                  summary: {
                    type: 'string'
                  }
                }
              }
            }
          ]
        };

        const turn = await adapter.createAgentTurn(request);

        assert.equal(turn.toolCalls.length, 1);
        assert.equal(turn.toolCalls[0]?.name, 'complete_task');
        assert.deepEqual(turn.toolCalls[0]?.arguments, {
          summary: 'site cree'
        });

        const sentMessages = capturedBody?.messages;
        assert.ok(Array.isArray(sentMessages));
        const assistantMessage = sentMessages?.[1] as Record<string, unknown>;
        const toolMessage = sentMessages?.[2] as Record<string, unknown>;
        const toolCalls = assistantMessage.tool_calls as Array<Record<string, unknown>>;
        const firstToolCall = toolCalls[0] as Record<string, unknown>;
        const toolFunction = firstToolCall.function as Record<string, unknown>;

        assert.equal(firstToolCall.type, 'function');
        assert.equal(toolFunction.index, 0);
        assert.equal(toolFunction.name, 'read_file');
        assert.deepEqual(toolFunction.arguments, {
          workspacePath: 'src/index.html'
        });
        assert.equal(toolMessage.role, 'tool');
        assert.equal(toolMessage.tool_name, 'read_file');
        assert.equal(toolMessage.content, '<html></html>');
        assert.equal(capturedBody?.think, false);
      } finally {
        server.close();
      }
    }
  }
];
