"use server";

import { redirect } from "next/navigation";
import { xcore } from "@/sso/runtime";
import { currentExchange } from "@/sso/session";

interface SignInState {
  refused: boolean;
}

/**
 * La connexion en doublure, par une Server Action.
 *
 * La librairie fait tout le travail : elle compare contre `di.accounts`, elle
 * scelle le cookie, elle tient la session - exactement comme face à x-core. Cette
 * action ne fait que lui passer la requête, la réponse et les deux champs.
 *
 * Elle a besoin de `res` parce qu'un cookie s'écrit sur une réponse, et elle l'a :
 * le serveur custom ouvre le contexte de requête pour `/login` aussi, précisément
 * pour ça.
 *
 * Un seul message pour les deux moitiés fausses : nommer laquelle indiquerait à qui
 * demande quelles adresses existent ici.
 */
export async function signIn(_previous: SignInState, form: FormData) {
  const { req, res } = currentExchange();

  const opened = await xcore().signInLocally(req, res, {
    email: String(form.get("email") ?? ""),
    password: String(form.get("password") ?? ""),
  });

  if (!opened) return { refused: true } satisfies SignInState;

  redirect("/");
}
