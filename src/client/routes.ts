/**
 * The three questions a page asks its OWN application, and never the provider.
 *
 * All of them on this origin, all of them carrying the sealed cookie and nothing
 * else. None of them holds state: each reads an answer and hands it back, and what
 * is done with it is decided where the session is held.
 *
 * @module
 */

import { asFields, readMe } from "../parse.js";

/**
 * The account, its details and its rights, from the application's own route.
 *
 * `null` for the account means signed out, which is an answer rather than a
 * failure: it is what a page renders its signed-out state from.
 *
 * The resource is ANSWERED rather than worked out here. A page cannot know which
 * resource its application is, and the convention it used to guess from - the
 * permission ending in `:access` - simply does not exist on an application that
 * declares no gate.
 */
export async function readSession(base: string) {
  const answer = await fetch(`${base}/session`, {
    // The sealed cookie is the credential, and it is `httpOnly`: nothing here
    // reads it, and this is what sends it.
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });

  if (answer.status === 401) return { resource: null, me: null };
  if (!answer.ok) throw new Error(`The session could not be read: ${answer.status}`);

  // Read field by field rather than trusted whole, exactly as the server half
  // reads it: a malformed answer becomes a named error here instead of an
  // `undefined` three components later, under a signed-in shell around nothing.
  const body = asFields(await answer.json());
  return {
    resource: typeof body?.resource === "string" ? body.resource : null,
    me: readMe(body?.data),
  };
}

/**
 * Ask for this application's session to be closed. The SSO's own stays open.
 *
 * The raw answer comes back rather than its contents, because the socket has to be
 * torn down BETWEEN the call and the reading of it: a client still dialling while
 * the body is parsed would reconnect onto a session that has just ended.
 */
export const endSession = (base: string) =>
  fetch(`${base}/logout`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).catch(() => null);

/**
 * Where the server says the reader goes, or an empty string.
 *
 * Never a constant here: the portal when this application is paired, its own
 * sign-in screen when the library is standing in.
 */
export async function exitOf(answer: Response | null) {
  const data = asFields(asFields(await answer?.json().catch(() => null))?.data);
  return typeof data?.exit === "string" ? data.exit : "";
}

/**
 * A ticket, or WHY there is none - and the two reasons are not the same thing.
 *
 * `401` is the session: it is over, and the reader has to be told. `404` is the
 * STREAM: this deployment has none - no bridge attached, or a library standing in
 * for a provider that is not there to push anything - and the reader is signed in
 * perfectly well.
 *
 * Collapsing them into "no ticket" signed everybody out on a deployment that
 * simply has no socket, and where the sign-out led back to a page that dialled
 * again, it did it forever.
 */
export async function takeTicket(base: string) {
  const answer = await fetch(`${base}/realtime-ticket`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (answer.status === 404) return { ticket: null, streamless: true };
  if (!answer.ok) return { ticket: null, streamless: false };

  const data = asFields(asFields(await answer.json())?.data);
  return { ticket: typeof data?.ticket === "string" ? data.ticket : null, streamless: false };
}
