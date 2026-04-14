const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig([
  {
    label: 'integration',
    files: 'out/test/integration/**/*.integration.test.js',
    workspaceFolder: '.',
    mocha: {
      ui: 'tdd',
      timeout: 20000
    }
  },
  {
    label: 'integration-live-agent',
    files: 'out/test/integration/**/*.integration.test.js',
    workspaceFolder: '.',
    env: {
      ESCTENTIONIALOCAL_LIVE_AGENT_E2E: '1',
      ESCTENTIONIALOCAL_LIVE_AGENT_MODEL: process.env.ESCTENTIONIALOCAL_LIVE_AGENT_MODEL ?? 'devstral-small-2:latest'
    },
    mocha: {
      ui: 'tdd',
      timeout: 420000
    }
  }
]);
