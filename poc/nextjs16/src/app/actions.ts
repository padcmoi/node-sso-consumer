"use server";

import { redirect } from "next/navigation";
import { SsoError } from "@gestionpratique/node-sso-consumer";
import { xcore } from "@/sso/runtime";
import { currentExchange, requireAccount, requirePermissions } from "@/sso/session";

/**
 * ── LES SERVER ACTIONS, ET CE QU'ELLES SONT VRAIMENT ───────────────────────────
 *
 * Une Server Action ressemble à une fonction que la page appelle. Ce n'en est pas
 * une : c'est un POST, son identifiant est écrit dans le HTML servi, et n'importe
 * qui peut le poster. La seule chose entre une action et le monde, c'est la ligne
 * de contrôle qui est dedans.
 *
 * C'est pour ça que rien ici ne fait confiance à la page. Le bouton masqué est une
 * politesse ; `requirePermissions` est le contrôle.
 *
 * Ces actions arrivent sur le serveur custom comme toute autre requête, donc elles
 * traversent le guard de la librairie AVANT d'être exécutées : une action postée
 * sans session est refusée par `di.errors` et n'entre jamais ici. Ce que les lignes
 * ci-dessous rajoutent, c'est la question suivante - pas « qui est-ce », mais « a-t-il
 * le droit ».
 */

/**
 * Fermer la session de CETTE application, pas celle du SSO.
 *
 * `logout` a besoin de la requête et de la réponse, parce qu'un cookie s'efface sur
 * une réponse. Elles sont là : l'action s'exécute dans le contexte asynchrone du
 * serveur custom, sur une `ServerResponse` que Next n'a pas encore envoyée. C'est
 * exactement ce qu'écrirait un handler Express, depuis une Server Action.
 */
export async function signOut() {
  const { req, res } = currentExchange();
  const exit = await xcore().logout(req, res);
  redirect(exit || "/");
}

interface ProbeState {
  status: "idle" | "granted" | "refused";
  action?: string;
  message?: string;
}

/**
 * Demander un droit précis, et se faire refuser pour de vrai.
 *
 * `assert` compare ce que x-core a répondu POUR CETTE REQUÊTE - rien n'est lu d'un
 * cache, d'un cookie ou d'un store client. Tapez un droit que le compte ne détient
 * pas : le refus vient d'ici, pas de l'écran.
 */
export async function probePermission(_previous: ProbeState, form: FormData) {
  const asked = String(form.get("action") ?? "").trim();
  if (!asked) return { status: "idle" } satisfies ProbeState;

  try {
    requirePermissions(asked);
    return { status: "granted", action: asked } satisfies ProbeState;
  } catch (error) {
    // FORBIDDEN est le seul refus qui parle du COMPTE : il est connecté, x-core a
    // répondu pour lui, et il ne détient pas ce droit. Il se dit là où le lecteur
    // se trouve. Tout le reste remonte.
    if (error instanceof SsoError && error.code === "FORBIDDEN") {
      return { status: "refused", action: asked, message: error.message } satisfies ProbeState;
    }
    throw error;
  }
}

/**
 * Ce que le compte détient, relu à l'instant.
 *
 * Une action qui ne fait que lire, pour montrer que le trajet est le même : elle
 * n'interroge pas x-core, elle lit ce que le serveur custom a déjà résolu pour cette
 * requête. Dix composants qui la lisent coûtent zéro appel.
 */
export async function readAccount() {
  const me = requireAccount();
  return { email: me.user.email, actions: me.permissions.global };
}
