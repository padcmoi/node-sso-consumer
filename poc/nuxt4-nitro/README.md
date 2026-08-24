# POC Nuxt 4 + Nitro, branché sur le SSO x-core

Nuxt 4 en front, **Nitro pour l'API**, Tailwind + Nuxt UI v4, MariaDB en réseau interne.

Cette application n'a **aucune authentification à elle**. C'est le fait principal de ce
POC, et ce n'est pas une simplification : c'est ce que la librairie remplace. Il n'y a
pas de table `users`, pas de colonne mot de passe, pas de table `sessions`, pas de
table de permissions, pas de page de connexion, pas de formulaire de réinitialisation
et aucun cache. Le compte, le profil et les droits sont demandés à x-core à chaque
requête, et ce qui est détenu ici est **un cookie scellé** contenant la paire de jetons
que x-core a émise.

Une session locale est exactement ce qui ne peut pas honorer une révocation : elle
serait encore valide. C'est la raison de tout le reste.

## Ce qu'il reste en base

| Table             | Ce que c'est                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `app_settings`    | l'étagère clé/valeur de cette app, que l'appairage remplit          |
| `hmac_credential` | le hash avec lequel elle signe l'API de x-core, livré par le broker |
| `services`        | ses **propres** données, la seule chose qu'elle ait jamais possédée |

Ni session, ni compte, ni permission. Les deux premières tables appartiennent à
l'application, pas à la librairie : celle-ci ne persiste rien et ne crée aucun schéma.

## Le jeton d'installation

**Ce POC ne fonctionnera pas tant qu'un jeton d'installation valide n'est pas posé.**
C'est voulu, et c'est la garantie qui compte : sans un jeton frappé sur
`manager.gestionpratique.ovh/portal-apps/install-tokens`, il est **impossible** de
s'enregistrer. Le hash qui signe n'arrive que par une queue de propagation créée au
moment où le jeton est frappé, donc une application qui ne l'a pas ne signe rien.

Une seule ligne à remplacer, dans [`server/utils/xcore.ts`](./server/utils/xcore.ts) :

```ts
installToken: 'ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o',
```

Elle y reste ensuite pour la vie de l'application : ce qui décide si l'échange a lieu
n'est pas sa présence mais la clé `INSTALLED` d'`app_settings`. Tant qu'elle ne vaut
pas `true`, le démarrage l'échange ; dès qu'elle vaut `true`, il ne la regarde plus.
Il n'y a donc pas d'`install()` à penser à appeler, et rien à retirer après coup.

Au moment de frapper le jeton, l'URL de retour à saisir sur la console est celle de ce
POC :

```
http://<hôte>:7003/api/auth/sso/callback
```

Et **rien d'autre n'est à recopier** : identité, URL d'annulation, template, barrière,
queue AMQP, compte broker et adresse du portail reviennent tous avec l'appairage et
sont rangés dans `app_settings`.

### Ce que le démarrage dit quand ça ne marche pas

`start()` ne lève jamais. Ce qu'il a fait revient en valeur, et une ligne le dit :

| `status`       | Ce que ça veut dire                                          |
| -------------- | ------------------------------------------------------------ |
| `ready`        | appairé et déclaré : le SSO sert                             |
| `not-paired`   | pas de jeton, ou un jeton refusé - avec les mots de x-core   |
| `not-declared` | x-core n'a pas été informé de la façon dont l'app se branche |

En `mode: 'local'` avec un annuaire prêté, le statut est `ready` lui aussi : la librairie
tient de vraies sessions, elle les tient simplement contre cette liste. Sans annuaire,
c'est `not-paired` et rien n'est servi derrière un garde.

L'application démarre dans tous les cas. Un démarrage qui mourrait sur un jeton dépensé
emporterait avec lui les pages qui n'ont rien à voir avec le SSO.

## Démarrage

```bash
pnpm prod:up          # docker compose up -d --build
pnpm prod:logs
pnpm prod:down
pnpm prod:reset       # supprime aussi le volume MariaDB
```

App : http://localhost:7003
phpMyAdmin : http://localhost:7004 (`root` / `DB_ROOT_PASSWORD`)

Le contexte de build est la racine de la librairie, pas ce dossier : ce POC installe le
**tarball** de `packages/`, parce que c'est lui qu'il sert à prouver.

## Le parcours

1. le portail x-core pointe sa carte sur `GET /api/auth/sso/start` ;
2. le navigateur revient sur `GET /api/auth/sso/callback`, le code est échangé et la
   paire est scellée dans le cookie ;
3. la page lit `GET /api/auth/session`, demande un ticket, et ouvre une socket sur
   `/_ws/realtime` ;
4. tout changement de compte, de profil, de droit ou de groupe arrive par cette socket
   en quelques secondes, sans rechargement ;
5. une déconnexion faite ailleurs ferme celle-ci et renvoie sur le portail.

## Pages

- `/` le compte, ses droits sur cette app, et l'état de la socket
- `/services` ses propres données, derrière la session
- `/test` ce que `me-changed` a poussé en dernier, brut

Retirez un droit depuis le manager pendant que la page est ouverte : la liste change
d'elle-même. C'est la frame qui EST la nouvelle valeur, il n'y a pas de relecture
derrière.

## API Nitro

| Route                            | Rôle                                            |
| -------------------------------- | ----------------------------------------------- |
| `GET /api/auth/sso/start`        | la carte du portail pointe ici                  |
| `GET /api/auth/sso/callback`     | le code revient, scellé en session              |
| `POST /api/auth/logout`          | ferme la session de CETTE app, pas celle du SSO |
| `GET /api/auth/session`          | le compte, ses détails, ses droits              |
| `POST /api/auth/realtime-ticket` | un ticket à usage unique, 30 s, pour la socket  |
| `GET /api/services`              | données métier, refusée sans session            |
| `GET /api/portal`                | où atterrit un navigateur sans session          |

Les cinq premières sont portées par la librairie, via
[`server/middleware/sso.ts`](./server/middleware/sso.ts). Aucune n'est écrite ici.

## Base de données

MariaDB 11.4, aucun port publié : joignable uniquement depuis le réseau Docker
`backend` (app + phpMyAdmin). Le schéma est créé au boot par
[`server/plugins/database.ts`](./server/plugins/database.ts), qui **supprime** au
passage les tables `users` et `sessions` de l'ancienne version.
