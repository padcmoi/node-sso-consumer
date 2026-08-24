/**
 * What arrives on the socket, and what each topic MEANS.
 *
 * The parsing is one thing and the meaning is another, and only the second is
 * interesting: a frame saying the account changed can be a repaint or a sign-out,
 * and telling those apart is the whole of this file.
 *
 * Nothing here holds state. The latch that `me-sessions` needs is answered as a
 * verdict and kept by whoever holds the session, because the read that settles it
 * is a read of the session.
 *
 * @module
 */

import { asFields, readMe } from "../parse.js";
import { admitted } from "./rights.js";
import type { SsoMe } from "../types.js";

/**
 * Followed for the whole session, whatever page is showing.
 *
 * THREE, and the third is what makes a revocation land. `me-changed` carries the
 * account and `me-signed-out` carries the end of it - but the provider computes that
 * second one from the IdP session and the account's access, and neither moves when
 * ONE application's session is ended from the sign-ins screen. So the frame never
 * comes, and the page keeps painting.
 *
 * `me-sessions` is the list that screen is drawn from, and the provider already marks
 * the caller's own line `current` in it. Nothing had to be added anywhere: the topic
 * exists, the flag exists, and this simply subscribes to it.
 */
export const ALWAYS = ["me-changed", "me-signed-out", "me-sessions"];

export interface FrameHandlers {
  /** The account, pushed whole and already admitted. */
  onAccount(me: SsoMe): void;
  /** The session is over, whatever said so. */
  onEnded(): void;
  /** The account's own list of sign-ins, for the latch. */
  onSessions(data: unknown): void;
  /** Anything the caller subscribed to itself. */
  onOther(topic: string, data: unknown): void;
}

/**
 * A frame worth acting on, or nothing.
 *
 * `#pong` answers the heartbeat and carries nothing: it has already done its job
 * by arriving, which is what moved the last-frame mark before this was called.
 */
export function parseFrame(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const frame = asFields(parsed);
  if (!frame) return null;

  const topic = typeof frame.topic === "string" ? frame.topic : null;
  if (!topic || topic === "#pong") return null;
  return { topic, data: frame.data };
}

/** One frame, handed to whichever of the four this topic means. */
export function routeFrame(raw: string, handlers: FrameHandlers) {
  const frame = parseFrame(raw);
  if (!frame) return;

  if (frame.topic === "me-changed") {
    // The frame IS the new value: written straight in, with no re-read behind
    // it, which is the whole point of holding this socket open.
    const pushed = readMe(frame.data);

    // Unless what it took away is the door. `<resource>:access` is not one right
    // among the others: an account that loses it is no longer a user of this
    // application, so this frame is a sign-out and not a repaint. Written in and
    // handed on, it would grey out every button and leave the reader sitting on a
    // page the server has already started refusing.
    if (!admitted(pushed)) return handlers.onEnded();

    handlers.onAccount(pushed);
    return;
  }
  if (frame.topic === "me-signed-out" && frame.data === true) {
    handlers.onEnded();
    return;
  }

  // The caller's own line in its own list of sign-ins. The provider marks it
  // `current`, and it stops being there the instant that session is ended from
  // the sign-ins screen - which is the ONE way of ending a session that
  // `me-signed-out` does not report, because neither the IdP session nor the
  // account's access has moved.
  if (frame.topic === "me-sessions") {
    handlers.onSessions(frame.data);
    handlers.onOther(frame.topic, frame.data);
    return;
  }
  handlers.onOther(frame.topic, frame.data);
}

/**
 * Whether this session is still in the account's own list of sign-ins.
 *
 * LATCHED, and it has to be: `current` is computed from the account, the app and
 * the IdP session, and a socket opened outside that flow has no line to match, so
 * "none is mine" would be true from the first frame and sign everybody out. It
 * means something only once a line HAS been seen and then goes - which is why the
 * latch is the caller's and is passed in.
 *
 * `"gone"` is a QUESTION rather than a conclusion. Rotation replaces the row every
 * fifteen minutes - the old one revoked, a new one issued - so a frame read in the
 * gap between the two shows no line of ours while the session is perfectly alive.
 * One read of `/session` settles it, and that read is the one that rotates and
 * re-seals anyway.
 */
export function ownSessionVerdict(data: unknown, enrolled: boolean) {
  if (!Array.isArray(data)) return "unknown";
  if (data.some((row) => asFields(row)?.current === true)) return "enrolled";
  return enrolled ? "gone" : "unknown";
}
