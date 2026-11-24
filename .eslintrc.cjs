module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'dist-binary', 'host-agent/dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['react-refresh'],
  // Injected by Vite's `define` (vite.config) — see src/version.js.
  globals: { __APP_VERSION__: 'readonly' },
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    // `_`-prefixed = deliberately unused (a placeholder argument, a caught
    // error that is only swallowed).
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    }],
    // `while (true) { … break; }` is the idiom for "mint the next free name".
    'no-constant-condition': ['error', { checkLoops: false }],
  },
}
