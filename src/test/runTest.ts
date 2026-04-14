import { agentOrchestratorTests } from './agentOrchestrator.test';
import { gpuGuardServiceTests } from './gpuGuardService.test';
import { ollamaAdapterTests } from './ollamaAdapter.test';
import { sessionStoreTests } from './sessionStore.test';
import { systemPromptTests } from './systemPrompt.test';
import { toolRuntimeTests } from './toolRuntime.test';

async function main(): Promise<void> {
  const tests = [
    ...toolRuntimeTests,
    ...agentOrchestratorTests,
    ...systemPromptTests,
    ...gpuGuardServiceTests,
    ...ollamaAdapterTests,
    ...sessionStoreTests
  ];
  let passed = 0;

  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`PASS ${test.name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`FAIL ${test.name}`);
      console.error(detail);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`All ${passed} tests passed.`);
}

void main();
