import js from '@eslint/js'
import globals from 'globals'

/**
 * The gate is deliberately split by runtime: server/CLI code is ESM under Node,
 * while `public/` is a classic script that only has browser globals. Treating
 * them as one environment is what let `window` and `process` both look defined
 * everywhere.
 */
export default [
  {
    ignores: ['node_modules/**', 'public/vendor/**', 'docs/assets/**', 'package-lock.json'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // A caught-but-unused binding is often deliberate documentation of intent
      // (`catch {` vs `catch (e)`), and unused args are common in Express
      // middleware where the arity is the contract.
      'no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      // The dashboard is a classic script whose entry points are called from
      // inline `onclick="switchTab()"` attributes in index.html. ESLint cannot
      // see those references, so every one of them reads as dead code here.
      // Turning the rule on would mean ~60 false positives; the real fix is
      // converting the markup to delegated listeners (tracked for the
      // dashboard modularisation), at which point this override comes out.
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]
