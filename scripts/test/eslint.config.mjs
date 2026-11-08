// @ts-check
// Lint for the AI layer's tests, the same rules as apps/web minus React's.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  files: ['**/*.ts'],
  rules: {
    '@typescript-eslint/consistent-type-imports': 'error',
  },
});
