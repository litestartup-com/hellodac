## What this changes

<!-- One paragraph. What was wrong, what is different now. -->

## Why

<!-- The problem, not the patch. Link the issue if there is one. -->

## How it was verified

<!--
   Paste the commands you ran. "It works" is not verification; the output is.
   For a bug fix: the test that failed before and passes now.
-->

- [ ] `npm run typecheck` / `npm run lint` / `npm test` / `npm run test:web` / `npm run i18n:check`
- [ ] manual check of the affected page or command (say which)

## Checklist

- [ ] Bug fixes come with a test that failed before the fix
- [ ] User-visible text lives in the locale files (English + Chinese both updated)
- [ ] `CHANGELOG.md` has an entry for user-visible changes
- [ ] Docs touched by this change are updated (`README.md` **and** `README.zh.md` stay in sync)
- [ ] Container deployment path considered (Dockerfile / compose / entrypoint) — see
      `manager/facts/container-deploy-facts.md`
