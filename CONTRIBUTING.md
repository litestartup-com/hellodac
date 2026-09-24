# Contributing to DAC

Thanks for taking the time. This file is short on purpose: it says how to get a change from
your machine into `master` without surprises.

## Ground rules

1. **Every bug fix starts with a failing test.** Write the assertion that reproduces it, watch
   it fail, then fix the code. A fix whose test never went red has not been shown to fix anything.
2. **Every change runs the whole gate locally** before you push:

   ```bash
   npm run typecheck   # tsc, three configs
   npm run lint        # eslint (0 errors expected; warnings are tolerated)
   npm test            # backend suite
   npm run test:web    # frontend suite
   npm run i18n:check  # every t('key') / {{t:key}} exists in both locales
   npm run build       # emits dist/ plus the locale files
   node scripts/check-docs.mjs
   ```

   All of the above in one command, plus the release-only static checks
   (required files, license holder, locale parity, image locks, landing page, CHANGELOG entry,
   leftover old brand names): `npm run release:check` (`-- --quick` skips the two test suites).

3. **Commit messages are in English.** This repository is the public one, so its history is
   public too: write the subject as `type: summary` in the imperative and explain the *why*
   in the body. (Internal design docs live in a separate, private repository and stay Chinese;
   code comments follow the language of the file they live in.) The public README exists in
   both languages: `README.md` (English) and `README.zh.md` (Chinese) must stay in sync.
4. **One concern per commit**, with a message that says what changed and why. The `CHANGELOG.md`
   entry lands with the change, not later.

## Working on the UI

- The interface is **English by default, Chinese switchable**. Never hardcode user-visible text:
  add a key to `src/i18n/locales/en.json` and `zh-CN.json` (the test asserts the two key sets
  are identical) and use `t('…')` or `{{t:…}}` in templates.
- Every page is composed at boot from `public/layout.html` + a fragment in `public/pages/`.
  A missing fragment, placeholder or translation key fails at startup on purpose.

## Working on the node agent

- The agent (`public/assets/agent/*`) runs on other people's servers: **Node ≥ 22.18, zero native
  dependencies, outbound HTTPS only**. Anything that needs a compiler or an inbound port is a
  design change, not an implementation detail — open an issue first.
- Its command channel is a fixed command set. If you find yourself wanting to execute arbitrary
  shell through it, stop and open an issue instead.

## Deployment changes

Container and bare-metal paths are both release-critical, and the container path has a list of
non-obvious rules (uid parity, named-volume ownership, no `rename` across bind mounts, single
source of truth for endpoint wiring). Read `manager/facts/container-deploy-facts.md` before
touching Dockerfiles, compose files or the entrypoint, and run the compose smoke test.

## Reporting issues

- Bugs: include the version, how it was deployed, what you expected, what happened, and any
  log lines (the manager logs to stdout; node logs are on the nodes page).
- Security problems: **not** as a public issue — see [SECURITY.md](./SECURITY.md).
- Feature ideas: open an issue describing the problem you have, not only the solution you want.
  It is much easier to agree on a problem than on an implementation.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
