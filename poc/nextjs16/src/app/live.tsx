'use client'

import { useEffect, useState } from 'react'
import { createSsoClient, signInUrl, type SsoBrowserClient } from '@gestionpratique/node-sso-consumer/client'

/**
 * La moitié navigateur, et c'est le même fichier que dans les deux POC Nuxt : du
 * `fetch` et un `WebSocket`, aucun framework. Elle ne sait pas ce qui la sert.
 *
 * Un composant client parce que ça lit un cookie et compose une socket - deux choses
 * qui appartiennent au navigateur. Rien ici ne s'exécute au rendu serveur.
 *
 * La liste des droits est rendue une première fois par le serveur, puis remplacée
 * par ce que la socket pousse : retirez un droit depuis le manager et il disparaît
 * d'ici en quelques secondes, sans rechargement et sans requête.
 */
export function Live({ portalUrl, initialActions }: { portalUrl: string | null; initialActions: string[] }) {
  const [connected, setConnected] = useState(false)
  const [actions, setActions] = useState(initialActions)

  useEffect(() => {
    let client: SsoBrowserClient | undefined

    client = createSsoClient({
      basePath: '/api/auth',
      // `me.permissions.global`, ce que la librairie répond tel quel : tout ce que le
      // compte détient dans l'écosystème, namespacé.
      //
      // Et pas `client.actions()`, qui est l'autre lecture et répond à une autre
      // question - « que peut-il faire ICI » : il filtre sur la ressource que cette
      // application déclare et en retire le préfixe. Les deux sont justes ; celle-ci
      // est celle que le rendu serveur a peinte, donc les deux moitiés disent la même
      // chose au lieu d'annoncer 115 au-dessus d'une liste de 6.
      //
      // La frame EST la nouvelle valeur : rien n'est relu derrière.
      onAccount: (me) => setActions(me.permissions.global),
      // Déconnecté au portail, compte désactivé, ou accès à CETTE application
      // révoqué. On part : rien ne se reconnecte dans une session terminée, et la
      // frame suivante serait refusée pour la même raison.
      onSignedOut: () => window.location.assign(portalUrl || signInUrl('/api/auth')),
      onConnectionChange: setConnected,
    })

    void client.connect()
    return () => client?.close()
  }, [portalUrl])

  return (
    <div className="space-y-4">
      {/* Le compte est ici et pas dans la page : il change quand la socket pousse, et
          un titre rendu côté serveur resterait sur la valeur du premier rendu. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Droits ({actions.length})</h2>
        <span className="rounded-md bg-sky-500/10 px-2 py-1 text-xs text-sky-400">poussés par websocket</span>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className={`size-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-slate-500'}`} />
        <span className={connected ? 'text-green-400' : 'text-slate-500'}>
          {connected ? 'temps réel ouvert' : 'temps réel fermé'}
        </span>
        <span className="text-slate-600">navigateur → serveur custom → x-core</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {actions.length ? (
          actions.map((action) => (
            <span
              key={action}
              className="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-xs text-slate-300"
            >
              {action}
            </span>
          ))
        ) : (
          <span className="text-sm text-slate-500">Aucun droit.</span>
        )}
      </div>
    </div>
  )
}
