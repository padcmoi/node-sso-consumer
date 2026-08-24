import { xcore } from "@/sso/runtime";
import { currentAccount } from "@/sso/session";
import { signOut } from "./actions";
import { Live } from "./live";
import { Probe } from "./probe";

/**
 * ── OBLIGATOIRE, ET ÇA NE SE VOIT PAS ──────────────────────────────────────────
 *
 * Sans cette ligne, `next build` affiche cette page comme `○ (Static)` et la
 * prérend À LA COMPILATION. Next décide statique/dynamique en regardant ce que la
 * page APPELLE - `cookies()`, `headers()`, une `searchParams` - et cette page
 * n'appelle rien de tout ça : elle lit un `AsyncLocalStorage`, ce que rien ne peut
 * détecter.
 *
 * Ce qui est alors servi à tout le monde, c'est le HTML rendu au moment du build,
 * avec `currentAccount()` à `null` : une page connectée, figée, sans personne
 * dedans. Le build réussit, le conteneur démarre, et rien ne le dit.
 *
 * C'est le prix du contexte implicite. Une application qui lirait la session par
 * `cookies()` serait marquée dynamique toute seule - et paierait le rescellement du
 * cookie qu'un Server Component ne peut pas écrire.
 */
export const dynamic = "force-dynamic";

/**
 * Un Server Component, et il ne fait AUCUN appel.
 *
 * `currentAccount()` lit ce que le serveur custom a résolu pour cette requête, dans
 * l'`AsyncLocalStorage`. Pas de `fetch("/api/auth/session")`, pas de cookie à
 * transmettre à la main, pas d'aller-retour HTTP de l'application vers elle-même -
 * ce que devrait écrire une application Next sans serveur custom, une fois par
 * composant qui a besoin du compte.
 */
export default function Home() {
  const me = currentAccount();
  const portalUrl = xcore().portalUrl || null;
  const actions = me?.permissions.global ?? [];

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-white">POC Next.js 16</h1>
          <p className="truncate text-sm text-slate-500">{me?.user.email}</p>
        </div>

        {/* Un formulaire, une Server Action, zéro JavaScript à écrire. Le cookie est
            effacé sur la vraie réponse HTTP, depuis l'action. */}
        <form action={signOut}>
          <button type="submit" className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5">
            Se déconnecter
          </button>
        </form>
      </header>

      <section className="rounded-lg border border-white/10 bg-slate-900/60 p-4">
        <p className="text-sm text-slate-400">
          Un seul process : les pages, les sept routes du SSO et la socket temps réel. Aucune route{" "}
          <code className="font-mono text-slate-300">/api</code> de cette application - les écritures passent par des Server
          Actions. Aucune table d&apos;utilisateurs, de mots de passe, de sessions ni de permissions : le compte et les droits
          sont demandés à x-core à chaque requête et jamais mis en cache.
        </p>
      </section>

      <section className="space-y-4 rounded-lg border border-white/10 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-white">Le compte, tel que x-core le répond</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-slate-500">Nom</dt>
            <dd className="mt-1 text-sm">{me?.user.displayName}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-slate-500">Identifiant</dt>
            <dd className="mt-1 truncate font-mono text-xs">{me?.user.id}</dd>
          </div>
        </dl>
      </section>

      {/* Le titre et le compte sont DANS `Live`, pas ici : ils changent quand la socket
          pousse, et un titre rendu côté serveur resterait sur la valeur du premier
          rendu pendant que la liste sous lui bougerait. */}
      <section className="rounded-lg border border-white/10 bg-slate-900/60 p-4">
        <Live portalUrl={portalUrl} initialActions={actions} />
      </section>

      <section className="space-y-4 rounded-lg border border-white/10 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-white">Demander un droit à une Server Action</h2>
        <p className="text-sm text-slate-400">
          L&apos;action est un POST public : son identifiant est dans cette page et n&apos;importe qui peut le poster. Ce qui la
          garde, c&apos;est la ligne <code className="font-mono text-slate-300">requirePermissions</code> qu&apos;elle contient,
          et rien d&apos;autre. Tapez un droit que ce compte ne détient pas.
        </p>
        <Probe suggestion={actions[0] ?? null} />
      </section>
    </main>
  );
}
