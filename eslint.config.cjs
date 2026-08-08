// Lint-only config: correctness rules, zero style rules. The house style
// (dense one-liners, mixed quotes, long lines) is deliberate — do not add
// formatting rules here.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // pervasive try{...}catch(e){} swallows around non-critical I/O are idiomatic
      'no-empty': ['error', { allowEmptyCatch: true }],
      // terse locals + destructured-but-unused config exports are common; warn, don't block
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // defensive initializers before try/catch reassignment (e.g. trader_daemon loop) are intentional
      'no-useless-assignment': 'warn',
    },
  },
];
