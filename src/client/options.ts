import type { SsoMe } from "../types.js";

/**
 * What a page LENDS to the client, and nothing it decides.
 *
 * Two addresses and four listeners: where the middleware answers on this origin,
 * where the socket is dialled, and what to do with what arrives. Nothing here is a
 * credential - the sealed cookie is the credential and this file never touches it.
 */
export interface SsoBrowserOptions {
  /**
   * Where the middleware is mounted, on THIS origin. The same `routes.basePath`
   * the server was given, and the only thing that normally has to be said twice.
   */
  basePath?: string;
  /** The path the realtime bridge listens on, when it was moved. */
  realtimePath?: string;
  /** The account as it changes, pushed whole. */
  onAccount?(me: SsoMe): void;
  /**
   * The session is over - signed out elsewhere, account disabled, access revoked.
   *
   * Send the reader to the portal from here. Nothing reconnects afterwards, and
   * nothing should: the next frame would be refused for the same reason.
   */
  onSignedOut?(): void;
  /** Anything else subscribed to. */
  onFrame?(topic: string, data: unknown): void;
  /** Beyond the three that are always on. */
  topics?: string[];
  /** Told when the stream comes and goes, for a badge saying so. */
  onConnectionChange?(connected: boolean): void;
}
