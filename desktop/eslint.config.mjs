// ESLint, for React's rules of hooks: hooks called the same way on every render, and effects, memos and
// callbacks that list what they use (a missing or extra dependency is how Home came to ask for its
// to-do list four times at launch). `npm run lint`; warnings fail it too.
//
// TypeScript 7 has no JavaScript API, so typescript-eslint can't parse this code; Babel's parser reads the
// TSX instead. That's syntax only: type checking stays with `tsc` (npm run typecheck).
import babelParser from '@babel/eslint-parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/**', 'release/**', 'node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        // Parse only (nothing is compiled): TypeScript and JSX syntax in every file. Babel's presets aren't
        // consulted for parsing here, so the syntax plugins are named directly.
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ['typescript', 'jsx'] } },
      },
    },
    plugins: { 'react-hooks': reactHooks },
    // An eslint-disable comment that no longer silences anything is reported, so stale ones don't pile up.
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
