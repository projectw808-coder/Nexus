// Root ESLint flat config (ESLint 10). Every package runs `eslint .` from its own directory;
// ESLint walks up to this file. Custom rules live in tooling/eslint-plugin-nexus.
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import nexus from './tooling/eslint-plugin-nexus/index.js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/db/src/generated/**',
      'apps/web/next-env.d.ts',
      'infra/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Every TS file must belong to a package tsconfig (each includes src + *.config.ts).
        // Plain JS (this file, tooling/) is linted without type information below.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { nexus },
    rules: {
      'nexus/no-direct-platform-fetch': 'error',
      'nexus/no-base-prisma': 'error',
      'nexus/no-raw-query': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs['recommended-latest'].rules,
    },
    settings: { next: { rootDir: 'apps/web' } },
  },
  {
    files: ['**/*.js', '**/*.mjs', 'tooling/**'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // CLI scripts and seeds talk to a terminal.
    files: ['**/scripts/**', 'packages/db/prisma/seed.ts', 'apps/web/e2e/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'packages/testing/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
