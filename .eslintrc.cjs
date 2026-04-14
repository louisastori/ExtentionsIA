module.exports = {
  root: true,
  env: {
    es2020: true,
    node: true,
    browser: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true
    }
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  ignorePatterns: ['out', 'media/webview', 'node_modules'],
  overrides: [
    {
      files: ['src/**/*.ts'],
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    {
      files: ['webview-ui/src/**/*.ts', 'webview-ui/src/**/*.tsx'],
      parserOptions: {
        project: './tsconfig.webview.json'
      }
    }
  ]
};
