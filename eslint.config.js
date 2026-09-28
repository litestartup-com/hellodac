import tseslint from 'typescript-eslint'

/**
 * P2-2: the point of lint is not style policing, it is **the few classes of real bugs the type system cannot catch**:
 *
 *  - `no-floating-promises` / `no-misused-promises`: this codebase is full of hand-annotated
 *    `void` async calls; miss one and "the error is swallowed and the turn fails silently".
 *  - `no-non-null-assertion`: the 5 existing `client!` uses are the type-level symptom of the
 *    missing driver abstraction (P1-2). Count them as warn first, do not block CI; flip to error
 *    once SessionDriver lands and they are back to zero.
 *  - `require-await` / `await-thenable`: catch fake async, the "looks async but is not" kind.
 *
 * Frontend `public/assets/*.js` is not covered yet (no type information, large), until the P2-1 split and
 * `// @ts-check` land.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-release/**', 'node_modules/**', 'public/**', 'data/**', 'workspaces/**', 'notes/**'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Debt R1: projectService only auto-discovers project files named `tsconfig.json`,
        // so `tsconfig.scripts.json` never takes part in matching -- all 11 scripts under scripts/
        // (.mjs/.ts) report a parsing error "not found by the project service",
        // and CI runs lint before the tests, so it is guaranteed red. The fix (the default
        // project route suggested by the external review on 2026-09-11): hand scripts/** to
        // allowDefaultProject, losing the type-aware rules, but their type safety is covered by
        // CI's `tsc -p tsconfig.scripts.json`
        // (the typecheck step); the base rules (syntax / style / non-type bug classes) still apply as before.
        projectService: {
          // An explicit extension list (not '**'): the ts-eslint guardrails reject an over-broad glob.
          allowDefaultProject: ['scripts/*.mjs', 'scripts/*.ts'],
          // 11 script files > the default cap of 8; the official escape valve (its name carries the warning).
          // The performance cost is negligible (11 small scripts) and it buys real
          // type-aware rule coverage over scripts (it caught 3 real errors on the first run).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // -- Real bug classes: error outright --
      '@typescript-eslint/no-floating-promises': 'error',
      // Argument positions are not checked: fastify's preHandler / hook type signatures return void, but at
      // runtime they really are awaited -- flagging them here would only drown out genuine "handed an async function to something that does not wait".
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',

      // -- Debt counters: warn, do not block CI (flip to error once they hit zero) --
      // Debt E10: non-null assertions in production code are back to zero, flip to error (test files are exempt, see below)
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Redundant type assertions: they really should be cleaned up, but that is pure cleanup; count them first, do not mix them into a safety batch
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      // Upstream frames are an unknown tree and the logging deliberately concatenates strings loosely (all of translate.ts does this);
      // this rule only manufactures noise here and buries the real problems
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',

      // -- Rules that clash with the project's existing style and carry no safety meaning: off --
      // The comments are full of Chinese and design notes, and mixing numbers/booleans into template strings is the norm
      '@typescript-eslint/restrict-template-expressions': 'off',
      // catch (error: unknown) + instanceof Error is this project's established style
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // tsc's noUnusedLocals/noUnusedParameters already cover this
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // `node:test`'s test() returns a Promise and not awaiting it is its idiom (the runner collects them itself);
    // reporting it as a "hanging promise" in test files would only drown out the real problems in production code.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      // Debt E10: the `!` in tests is an assertion idiom, exempt (production code has been flipped to error)
      '@typescript-eslint/no-non-null-assertion': 'off',
      // In tests, awaiting a non-async stub and throwing a non-Error object are both harmless: count, do not block
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/only-throw-error': 'warn',
    },
  },
)
