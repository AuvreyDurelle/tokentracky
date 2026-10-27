import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/release/**', '**/out/**', '.cache/**', '.runtime/**', '.vercel/**', 'coverage/**', 'mockups/**', '**/target/**', 'apps/mac/**', '.worktrees/**'] },
  { files: ['packaging/**/*.mjs'], languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly', Response: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', AbortSignal: 'readonly' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: { '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}] }
  }
);
