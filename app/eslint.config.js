import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// Two lint domains coexist during the strangler-fig migration:
//   • Legacy `.js/.jsx` - unchanged rules, so migration doesn't churn old files.
//   • New `.ts/.tsx`     - typescript-eslint recommended + react-hooks, with
//     react-refresh scoped to `.tsx` component files only.
export default tseslint.config(
  // dist-e2e is the hermetic bundle the Playwright suite builds for itself.
  { ignores: ['dist', 'dist-e2e'] },

  // The i18n tooling decides what "done" means for the whole migration, so it
  // gets the same gate as the app. It had a duplicate object key that no check
  // would have caught.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { 'no-dupe-keys': 'error', 'no-unused-vars': 'warn' },
  },

  // ── Legacy JavaScript / JSX ──────────────────────────────────────────────
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]|^motion$' }],
    },
  },

  // ── New TypeScript / TSX (Admin 2.0 foundation) ──────────────────────────
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    extends: [reactRefresh.configs.vite],
  },
)
