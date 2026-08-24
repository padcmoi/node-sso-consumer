import { SsoError, statusOf } from "@gestionpratique/node-sso-consumer";
import { NoteEntity, type NoteRow } from "../utils/entities";
import type { H3Event } from "h3";

/**
 * The account behind a request, with the rights asked for in the SAME call.
 *
 * Nothing here decides anything: the library reads the session, checks the actions,
 * and refuses. Authenticating and authorising in one call is deliberate - a route
 * that did the first and forgot the second would be asserting rights against nobody.
 *
 * THE MAPPING IS HERE, and it has to be. `middleware.account()` is the entry point a
 * handler CALLS rather than sits behind, and it throws a typed `SsoError` instead of
 * going through `di.errors` - which is right for it, since a caller that asked for
 * the account is also the one that decides how its own route answers. Left to
 * travel, though, Nitro reads it as an unknown throw and answers `500`.
 */
const requirePermissions = async (event: H3Event, ...actions: string[]) => {
  try {
    return await xcore.middleware.account(event.node.req, event.node.res, ...actions);
  } catch (error) {
    if (error instanceof SsoError) {
      throw createError({ statusCode: statusOf(error), statusMessage: error.message });
    }
    throw error;
  }
};

/**
 * This application's OWN data, behind its OWN rule.
 *
 * `read:note` is namespaced by the library against this application's own resource.
 * `admin@example.test`, whose list is empty, passes anyway because `isRoot` is read
 * before the list is.
 */
export default defineEventHandler(async (event) => {
  const me = await requirePermissions(event, "read:note");

  const repo = await useRepo<NoteRow>(NoteEntity);
  const notes = await repo.find({ order: { id: "ASC" } });

  return { reader: me.user.email, notes: notes.map((n) => ({ id: n.id, title: n.title, body: n.body, owner: n.owner })) };
});
