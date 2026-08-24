# POC Nuxt 4 (relais) + NestJS (le SSO)

Le second POC de cette librairie, et il existe pour une seule raison : **prouver que
la librairie est agnostique du framework**.

Le premier, [`../nuxt4-nitro`](../nuxt4-nitro), fait tourner la librairie dans le
Nitro d'un Nuxt : un seul processus, qui sert les pages et tient la session. Celui-ci
la fait tourner dans une **API NestJS** que le navigateur n'atteint jamais, derrière
un **relais Nitro** - l'architecture de `manager-infra`, et celle de la majorité des
projets de cette maison.

Le navigateur ne voit aucune différence. `app/plugins/sso.client.ts`,
`app/composables/useSso.ts` et les pages sont les mêmes fichiers que dans l'autre
POC.

## Ce que tient chaque moitié

| | `app/` - Nuxt 4 | `api/` - NestJS 11 |
| --- | --- | --- |
| Publié sur l'hôte | `127.0.0.1:7010` | rien |
| SSO | **zéro ligne** | tout |
| Contenu de `server/` | une liste blanche, un relais HTTP, un relais WebSocket | - |
| Base de données | aucune | `app_settings`, `hmac_credential` |
| Pages | oui | aucune |

Il n'y a **ni table `users`, ni colonne mot de passe, ni table `sessions`, ni table de
permissions**. C'est ce que la librairie remplace, pas ce qu'elle enveloppe. Une ligne
de session locale est précisément ce qui ne peut pas honorer une révocation - elle
serait toujours valide.

## Le chemin d'une requête

```
navigateur                nginx                  app (Nuxt)              api (Nest)            x-core
   |                        |                        |                       |                    |
   |-- GET / -------------->|-- 127.0.0.1:7010 ----->| page servie ici       |                    |
   |                        |                        |                       |                    |
   |-- GET /api/me -------->|----------------------->|-- allowlist --------->| XcoreGuard         |
   |                        |                        |   proxyRequest        |------ session ---->|
   |                        |                        |                       |<--- compte+droits -|
   |                        |                        |                       |                    |
   |== WS /_ws/realtime ===>|== Upgrade ============>|== relais ws ==========>| pont HMAC ========>|
```

Deux points de vigilance, et ce sont ceux qui cassent silencieusement :

1. **Le callback est l'adresse du FRONT**, pas celle de l'API. C'est une navigation :
   le navigateur la parcourt, et il ne connaît que `https://tvx-gp3.gestionpratique.ovh`.
   Déclaré contre le conteneur `api`, l'appairage passe au vert, la déclaration
   réussit, et la première connexion meurt sur une adresse que rien ne résout.
2. **Le relais doit ENVOYER `x-forwarded-for` et `accept`.** C'est le relais qui
   compte, pas l'API : la librairie lit `x-forwarded-for` elle-même dans les en-têtes
   bruts, donc sans lui chaque session est classée sous l'adresse du conteneur `app`
   au lieu de celle du lecteur. Et h3 avale `accept`, ce qui rend toute négociation de
   contenu impossible - voir plus bas.

   `trust proxy` sur l'API est de l'hygiène Express, pas une dépendance : ça corrige
   `req.ip`, `req.protocol` et `req.secure` pour ce que l'application ajoute, mais la
   librairie ne lit aucun des trois, et le drapeau `Secure` du cookie vient de la
   configuration, écrit à la main. Ce README affirmait le contraire.

## Ce que ce POC a trouvé

`docs/nestjs.md` n'avait jamais démarré. Le faire tourner a sorti deux fautes, et les
deux sont silencieuses :

1. **La carte `exports` de la librairie refusait tout consommateur CommonJS.** Un seul
   `types` pour les deux conditions, et comme le paquet est `"type": "module"`,
   TypeScript lisait cette déclaration comme de l'ESM : `TS1479` sur chaque import,
   depuis n'importe quel projet NestJS de cette maison - tous en `nodenext`. Les
   fichiers `.d.cts` étaient construits et publiés depuis le début, rien ne pointait
   dessus. Corrigé dans `package.json` : `import` et `require` ont chacun leur
   `types`.
2. **Monter les six routes avec `consumer.apply(...).forRoutes("*")` ne marche pas** -
   c'est pourtant ce que `docs/nestjs.md` décrit. Express retire le chemin de montage
   de `req.url` avant que le handler ne le voie : la librairie lit `/` pour chaque
   requête, ne reconnaît aucune de ses six routes, les passe toutes plus loin, et ce
   qui sort est un `404` de Nest sur `/api/auth/session`. Aucun log, aucune route pour
   se connecter. Le montage correct est un `app.use()` global dans `main.ts`, sans
   chemin - voir [`api/src/main.ts`](api/src/main.ts).

`docs/nestjs.md` décrit toujours le mauvais montage.

## Ce POC est vierge

Il démarre, il le dit en une ligne, et il ne sert rien derrière le SSO. C'est l'état
que le log appelle `not-paired`, et c'est un blanc qui fonctionne, pas une panne.

Pour le brancher :

1. Sur la console x-core, « Portails applicatifs », minter un token d'installation.
   À l'étape « L'application », déclarer le callback :

   ```
   https://tvx-gp3.gestionpratique.ovh/api/auth/sso/callback
   ```

2. Coller le token dans [`api/src/sso/xcore.service.ts`](api/src/sso/xcore.service.ts),
   clé `installToken`.
3. `pnpm prod:up`.

Il n'y a **rien d'autre à copier**. L'identité, l'URL de callback, la porte, les
identifiants du broker et le mot de passe qui scelle le cookie reviennent avec
l'appairage et vivent dans `app_settings`. Ce qui décide si l'échange a lieu n'est pas
la présence du token mais la clé `INSTALLED` : tant qu'elle n'est pas vraie le boot
échange, une fois qu'elle l'est le boot ne le regarde plus jamais.

## Le reverse proxy

Ce POC attend d'être servi sur `https://tvx-gp3.gestionpratique.ovh`, par un vhost qui
relaie vers `127.0.0.1:7010`. Il doit **passer `Upgrade` et `Connection`**, sinon la
route `/_ws/realtime` n'est jamais atteinte et la page reste sur « hors ligne » sans
rien dans aucun log. Les deux ports du compose sont volontairement liés à la loopback.

## Commandes

```bash
pnpm prod:up      # construit et démarre les quatre conteneurs
pnpm prod:logs    # les logs de l'API, où le boot du SSO se lit
pnpm prod:down    # arrête
pnpm prod:reset   # arrête et supprime le volume : l'appairage est perdu
```

`prod:reset` efface `app_settings`, donc `INSTALLED` : au prochain boot le token est
réutilisé, et x-core a supprimé sa ligne au moment où il a été dépensé. Il faut en
minter un nouveau.

## Sans x-core

`mode: "local"` dans `api/src/sso/xcore.service.ts` : la librairie ne se retire pas,
elle **remplace** x-core contre `di.local_accounts`. Vraies sessions, guards qui
refusent, session de la forme exacte que x-core répond - seule la réponse à « qui
est-ce » vient d'une liste dans ce fichier. La liste est vide ici ; l'écran de
connexion est [`app/app/pages/login.vue`](app/app/pages/login.vue).

## Ce que ce POC ne fait pas

- **Un seul process.** Les tickets du temps réel vivent en mémoire. Plusieurs workers
  demandent une élection et un magasin partagé : voir [`../../docs/multi-process.md`](../../docs/multi-process.md).
- **`live` est à `false`.** Il ne sert qu'à alimenter `di.onAccount` et
  `di.onSignedOut`, qui ne sont pas prêtés ici. Le temps réel que voit le lecteur ne
  vient pas de là : c'est le pont à ticket, et il est actif.
