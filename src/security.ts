import helmet from '@fastify/helmet'
import type { FastifyInstance } from 'fastify'

/**
 * P1-1: security response headers.
 *
 * Why this is needed: the front end has many `innerHTML` render sites fed with model output, workspace
 * files and node logs; the only defence is the hand-written escape-first renderer (`public/assets/md.js`),
 * whose safety rests on a manual invariant -- "every regex runs on already-escaped text". CSP is the second
 * gate on top of that: even if one escape is missed somewhere, injected script has no origin it can run from.
 *
 * Two deployment constraints (helmet's defaults violate both, hence the explicit overrides):
 *
 * 1. **Plain HTTP is a supported shape** (one of nginx's three modes; install.sh defaults to HTTP).
 *    So: no `upgrade-insecure-requests` (it would upgrade working HTTP pages into unreachable
 *    HTTPS), and HSTS only under TLS (`secure` follows the same check as the session cookie's secure).
 * 2. **The front end still uses inline style attributes** (board/spend rendering), so `style-src` allows
 *    `'unsafe-inline'`; `script-src` allows it never -- the login page's inline script was externalised for this.
 */
export const registerSecurityHeaders = async (app: FastifyInstance, secure: boolean): Promise<void> => {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        // Same-origin scripts only: inline and eval are never allowed
        'script-src': ["'self'"],
        // Inline style attributes are still in use; style injection is far less harmful than script, so allow now, tighten later
        'style-src': ["'self'", "'unsafe-inline'"],
        // data: for inline small icons/placeholder images
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'data:'],
        // same-origin fetch and SSE (EventSource)
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // HSTS only means anything over HTTPS; sending it on a plain-HTTP deployment pins the site into being unreachable
    hsts: secure ? { maxAge: 15552000, includeSubDomains: false } : false,
    // There is no cross-origin isolation need in the app; enabling it would only block legitimate resources
    crossOriginEmbedderPolicy: false,
  })
}
