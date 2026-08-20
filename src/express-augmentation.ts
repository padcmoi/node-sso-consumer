/**
 * What the session guard puts on the request, told to the framework's own types.
 *
 * The library types its OWN `WebRequest`, which is what it reads. But a handler
 * does not receive that: it receives Express's `Request`, or Nest's, or Nitro's
 * event - and on those, `req.me` is a property nobody declared. Every application
 * was writing the same augmentation, or reaching for `any` and losing the shape of
 * the thing it came here for.
 *
 * Imported for its EFFECT and nothing else, once, anywhere in an application:
 *
 *   import "@gestionpratique/node-sso-consumer/express";
 *
 * A subpath rather than the main entry, because it is a global declaration: an
 * application on Fastify or Nitro has no `Express.Request` to augment and has no
 * business being handed a namespace named after one.
 *
 * @module
 */

import type { SsoMe, SsoTokens } from "./types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The account, its details and its rights, as the provider answered them for
       * THIS request. Present behind `requireSession()`, and nowhere else.
       */
      me?: SsoMe;
      /**
       * The pair, rotated if it had to be. For a handler opening a stream of its
       * own; a handler serving a page has no use for it.
       */
      ssoTokens?: SsoTokens;
      /** The account this session belongs to. Keyed on by everything upstream. */
      ssoUserId?: string;
    }
  }
}

export {};
