import { LoginForm } from './form'

/**
 * L'écran de connexion, et SEULEMENT pendant que la librairie remplace x-core.
 *
 * Avec `enabled: true` personne n'atterrit ici : le portail est le seul endroit où
 * quelqu'un se connecte, et le guard du serveur custom y envoie un lecteur sans
 * session. Cette page existe parce qu'en doublure il n'y a pas de portail.
 *
 * Le partage est délibéré : la librairie tient le LOGIN - elle compare, elle scelle
 * le cookie, elle tient la session, exactement comme face à x-core - et cette page
 * tient l'ÉCRAN. Une librairie ne rend pas une page React.
 */
export default function Login() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-white/10 bg-slate-900/60 p-6">
        <div>
          <h1 className="text-base font-semibold text-white">POC Next.js 16</h1>
          <p className="text-sm text-slate-500">Comptes locaux, x-core est éteint</p>
        </div>

        <LoginForm />

        <p className="text-xs text-slate-500">
          Ces comptes vivent dans <code className="font-mono">src/sso/runtime.ts</code>. Avec{' '}
          <code className="font-mono">enabled: true</code>, cet écran n&apos;est jamais atteint.
        </p>
      </div>
    </main>
  )
}
