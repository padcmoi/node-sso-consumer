"use client";

import { useActionState } from "react";
import { probePermission } from "./actions";

/**
 * Le formulaire, et rien de plus.
 *
 * Aucun contrôle ici, volontairement. On tape un droit, on poste, et c'est la Server
 * Action qui décide - `assert` contre ce que x-core a répondu pour cette requête.
 * Si ce composant vérifiait quoi que ce soit, il donnerait l'illusion que la porte
 * est côté écran.
 */
export function Probe({ suggestion }: { suggestion: string | null }) {
  const [state, submit, pending] = useActionState(probePermission, { status: "idle" as const });

  return (
    <form action={submit} className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          name="action"
          defaultValue={suggestion ?? ""}
          placeholder="read:user"
          className="w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {pending ? "…" : "Demander"}
        </button>
      </div>

      {state.status === "granted" && (
        <p className="text-sm text-green-400">
          Droit <span className="font-mono">{state.action}</span> détenu : l&apos;action est allée au bout.
        </p>
      )}
      {state.status === "refused" && (
        <p className="text-sm text-red-400">
          Refusé par le serveur : <span className="text-slate-400">{state.message}</span>
        </p>
      )}
    </form>
  );
}
