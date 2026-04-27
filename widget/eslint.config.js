import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'storybook-static', 'test-results', 'playwright-report']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        // Vite `define` globals injected at build time.
        __WIDGET_VERSION__: 'readonly',
        __WIDGET_BUILD__: 'readonly',
        __WIDGET_BASE__: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // Vite config files run in Node, not the browser.
  {
    files: ['vite.config.js', 'vite.*.config.js', 'scripts/**/*.js', 'playwright.config.js', 'tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
])
