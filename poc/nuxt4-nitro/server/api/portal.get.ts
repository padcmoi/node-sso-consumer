/**
 * Where a browser goes when it has no session, and where it lands after a sign-out.
 *
 * ONE address for three exits, and they are the same exit seen from three sides: a
 * reader who signs out, a session refused because it is over, and a session revoked
 * from somewhere else. The portal is the only thing in this ecosystem that signs a
 * human in.
 *
 * Served rather than written into the page, because x-core is what knows where its
 * own portal lives: it answers the address at pairing, and a copy in a build would
 * keep sending readers to one that has moved.
 *
 * No session is required to read it. It is a public URL and it is the one thing
 * somebody with no session legitimately needs.
 */
export default defineEventHandler(() => ({ url: xcore.portalUrl || null }));
