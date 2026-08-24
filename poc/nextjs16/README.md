# POC Next.js 16 - un seul process, et des Server Actions

Le troisième POC de cette librairie. Les deux premiers prouvaient qu'elle survit à un
changement de framework ; celui-ci prouve qu'elle survit à un changement de **modèle
d'exécution**.

- [`../nuxt4-nitro`](../nuxt4-nitro) - la librairie tourne dans le Nitro d'un Nuxt
- [`../nuxt4-nest`](../nuxt4-nest) - elle tourne dans une API NestJS derrière un relais
- **ici** - elle tourne dans un serveur Node qui possède Next, et l'application écrit
  par des Server Actions plutôt que par des routes

Aucune route `/api` appartenant à l'application. Les seules qui existent sont les six
de la librairie.

## Pourquoi un serveur custom, et pourquoi ce n'est pas « une API en plus »

Un seul process, un seul port, un seul conteneur. `server.ts` possède le
`http.Server` et passe à Next tout ce qui est à Next. Deux choses rendent ce détour
obligatoire :

1. **Les route handlers du App Router parlent `Request`/`Response` du Web.** La
   librairie parle `IncomingMessage`/`ServerResponse` - ce que tout framework Node
   porte en dessous. Sans serveur custom il faudrait un adaptateur écrit deux fois,
   dans les deux sens, pour chacune des six routes.
2. **`realtime.attach()` a besoin de l'événement `upgrade`**, et Next ne donne le
   serveur à personne. Sans ce fichier, pas de socket du tout : aucune permission
   n'arrive sur une page ouverte, aucune révocation ne se voit avant la navigation
   suivante.

## Pourquoi la session est résolue là, et pas dans un composant

`sessionOf()` interroge x-core, fait tourner la paire de jetons quand il le faut, et
**rescelle le cookie**. Or écrire un cookie est exactement ce qu'un Server Component
n'a pas le droit de faire - Next le refuse. Résoudre la session pendant un rendu
laisserait donc tomber le rescellement, et casserait toutes les sessions au premier
renouvellement, un quart d'heure plus tard, sans un mot dans les logs.

Résolue dans le serveur custom, elle est écrite sur une vraie `ServerResponse` que
Next n'a pas encore envoyée, et le compte voyage jusqu'au rendu par un
`AsyncLocalStorage`.

Ce que ça donne dans les pages :

```tsx
const me = currentAccount()   // une lecture mémoire, zéro aller-retour
```

Dix composants qui posent la question coûtent zéro appel à x-core. Sans serveur
custom, chacun devrait faire un `fetch("/api/auth/session")` - l'application appelant
sa propre HTTP, avec le cookie retransmis à la main.

## Les Server Actions

C'est le sujet de ce POC autant que le SSO.

**Une Server Action n'est pas une fonction que la page appelle.** C'est un POST, son
identifiant est écrit dans le HTML servi, et n'importe qui peut le poster. La seule
chose entre une action et le monde, c'est la ligne de contrôle qui est dedans.

Deux étages, et ils sont distincts :

- le guard de la librairie tourne dans le serveur custom, **avant** que Next ne voie
  la requête : une action postée sans session est refusée et n'entre jamais dans le
  code de l'application ;
- `requirePermissions("…")` **dans l'action** répond à la question suivante - pas
  « qui est-ce », mais « a-t-il le droit ».

La page en contient une démonstration jouable : tapez un droit que le compte ne
détient pas, le refus vient de `assert()` côté serveur, contre ce que x-core a
répondu pour cette requête. Aucun cache, aucun cookie, aucun store client.

`signOut()` est une action aussi, et elle montre l'autre moitié : elle récupère les
`req`/`res` bruts du contexte et appelle `xcore().logout(req, res)`. Le cookie
s'efface sur la vraie réponse HTTP, depuis une Server Action.

## Trois pièges rencontrés en construisant ce POC

**1. Deux graphes de modules.** `server.ts` est compilé par `tsc` et chargé par node ;
`src/app/**` est compilé et chargé par Next. Importer le même fichier des deux côtés
donne deux évaluations : deux bridges, deux `AsyncLocalStorage`, deux pools. Le
serveur résout la session dans SON store, la page lit LE SIEN, ne trouve rien, et
chaque lecteur est déconnecté sur une requête parfaitement authentifiée - sans une
ligne de log. En développement c'est pire : Next réévalue à chaque sauvegarde.

Une seule instance, épinglée sur `globalThis` : voir [`src/sso/runtime.ts`](src/sso/runtime.ts).
C'est la même raison qui fait épingler un client Prisma là, et ce n'est pas un
contournement - deux graphes, c'est ce que le framework EST.

**2. La page était prérendue statique.** Next décide statique ou dynamique en
regardant ce que la page appelle : `cookies()`, `headers()`, `searchParams`. Cette
page n'appelle rien de tout ça - elle lit un `AsyncLocalStorage`, que rien ne peut
détecter. `next build` la marquait `○ (Static)` et servait à tout le monde le HTML
rendu à la compilation, avec un compte à `null`. Le build réussit, le conteneur
démarre, et rien ne le dit. D'où le `export const dynamic = 'force-dynamic'` en tête
de [`src/app/page.tsx`](src/app/page.tsx).

**3. `next.config` en TypeScript.** Next parse ce fichier au BOOT, et un `.ts` fait
dépendre ce parsing de `typescript`, qui est une devDependency. L'image se construit
parfaitement et refuse de démarrer. Le fichier est en `.mjs`.

## Ce POC est vierge

Il démarre, le dit en une ligne, et ne sert rien derrière le SSO - l'état que le log
appelle `not-paired`.

Pour le brancher :

1. Publier ce POC derrière un vhost HTTPS qui relaie vers `127.0.0.1:7009`, en
   passant `Upgrade` et `Connection` - sinon la socket n'est jamais atteinte et la
   page reste sur « temps réel fermé », sans rien dans aucun log. C'est
   `sync-gp3.gestionpratique.ovh` ici.
2. Sur la console x-core, « Portails applicatifs », minter un token d'installation
   avec le callback `https://sync-gp3.gestionpratique.ovh/api/auth/sso/callback`.
   C'est une navigation : le navigateur la parcourt, donc c'est l'adresse publique.
3. Coller le token dans [`src/sso/runtime.ts`](src/sso/runtime.ts), clé
   `installToken`, puis `pnpm prod:up`.

Une identité SSO = un callback : ce POC a besoin de son propre domaine et de son
propre token, il ne peut pas partager ceux d'un autre.

## Commandes

```bash
pnpm prod:up      # construit et démarre les trois conteneurs
pnpm prod:logs    # le boot du SSO se lit ici
pnpm prod:down
pnpm prod:reset   # supprime le volume : l'appairage est perdu, il faut un nouveau token
```

## Sans x-core

`mode: "local"` dans `src/sso/runtime.ts` : la librairie ne se retire pas, elle
**remplace** x-core contre `di.local_accounts`. Vraies sessions, guards qui refusent,
session de la forme exacte que x-core répond. La liste est vide ici ; l'écran est
[`src/app/login/page.tsx`](src/app/login/page.tsx), et il se connecte par une Server
Action qui appelle `signInLocally`.

## Ce que ce POC ne fait pas

- **Un seul process.** Les tickets du temps réel vivent en mémoire. Plusieurs workers
  demandent une élection et un magasin partagé : voir
  [`../../docs/multi-process.md`](../../docs/multi-process.md).
- **`live` est à `false`.** Il n'alimente que `di.onAccount` et `di.onSignedOut`, qui
  ne sont pas prêtés ici. Le temps réel que voit le lecteur ne vient pas de là : c'est
  le pont à ticket, et il est actif.
- **Pas de déploiement serverless.** Un serveur custom exclut Vercel et consorts. En
  Docker, ce qui est le cas ici, ça ne coûte rien.
