/**
 * The single source of truth for branding (DAC v1.0.0).
 *
 * The product name, repo URL, site and tagline appear exactly once, here: page rendering (the
 * {{BRAND}}/{{REPO_URL}} placeholders in pages.ts), the sidebar entry and the ⋮ menu footer all read
 * from it. Scattered URLs mean grepping the whole repo to change a domain and always missing one --
 * which is where UI.md's 'single source of truth' line comes from.
 *
 * Note: this is the **product brand**, not a code identifier. The mechanical rename of `dac` to
 * `dac` (B2) takes another path (package name/paths/env/cookie); neither replaces the other.
 */
export interface Brand {
  /** The outward product name (page title, sidebar, footer). */
  name: string
  /** The expanded full name (README, the about dialog). */
  fullName: string
  /** The one-line positioning. */
  tagline: string
  /** The public repository. */
  repoUrl: string
  /** The site. */
  homepage: string
  /** The support email (the contact in the about dialog). */
  supportEmail: string
  /** The brand mark (a single character, the sidebar square). */
  mark: string
}

export const BRAND: Brand = {
  name: 'DAC',
  fullName: 'Dispatched Agent Cluster',
  tagline: 'One Manager. A Fleet of Agents.',
  repoUrl: 'https://github.com/litestartup-com/hellodac',
  homepage: 'https://hellodac.com',
  supportEmail: 'support@hellodac.com',
  mark: 'D',
}
