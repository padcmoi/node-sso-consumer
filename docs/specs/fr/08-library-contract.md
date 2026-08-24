# Ce qu'est la librairie, et ce qu'elle refuse d'être

Une implémentation de tout ce dossier, pour qu'une application n'en tienne rien.

Ce document décrivait autrefois un contrat conçu **avant** que rien n'en soit construit, et il n'a pas survécu au contact : chaque option a été renommée, l'identité a cessé d'être configurée du tout, et la déclaration a migré vers la console. Ce qui suit est la surface telle qu'elle est réellement. Pour savoir comment l'écrire, avec chaque option commentée, voir [Le fichier de service](../../guides/fr/service.md).

## Trois règles qu'elle s'impose

**Elle ne persiste rien.** Pas de table, pas de migration, pas de schéma. Une application qui l'installe n'en crée aucune, et il n'y a pas de magasin à sauvegarder. L'état qui existe vit dans le cookie scellé du lecteur et dans x-core.

**Elle ne lit aucun `process.env`.** Tout entre en argument ou en fonction injectée. Un bundler remplace `process.env.NODE_ENV` par une constante au moment de la construction, donc une valeur lue depuis une librairie embarquée porte ce qui était vrai sur la machine qui a construit l'image plutôt que ce qui est vrai au démarrage. La ligne de l'application vit dans le build de l'application, qui sait.

**Elle ne possède aucun credential.** Aucun secret ne la traverse. Elle demande le hash courant avant chaque signature et en rend un à ranger ; où est ce magasin, et comment une rotation l'atteint, est l'affaire du déploiement ([07-reference-apps.md](07-reference-apps.md)).

## Ce qu'on lui donne

Un objet, à la construction, via `createXcoreBridge`.

```
mode          "sso" ou "local" : QUEL ANNUAIRE répond. La première clé, parce
              qu'elle décide toutes les autres. Obligatoire, sans défaut.
              À "local" la librairie authentifie quand même, contre di.local_accounts.

provider      { baseUrl, frontUrl?, realtimeUrl?, portalUrl? }
              baseUrl est l'API AVEC SON PORT, et la seule adresse qu'un intégrateur
              tape. Elle est sondée avant que rien ne lui soit déclaré. Les trois
              autres sont dérivées si absentes, et l'appairage en répond deux.

installToken  la valeur frappée sur la console, et la SEULE qu'un opérateur recopie.
              Elle reste là pour la vie de l'application : ce qui décide si l'échange
              a lieu est la clé INSTALLED, pas ce champ.

session       { cookie?: { stateName?, secure?, sameSite?, path?, domain?,
                           maxAgeDays? } }
              Pas de mot de passe et pas de nom : le premier est tiré au premier
              démarrage, le second est dérivé de l'identité par x-core.

routes        { basePath?, afterLogin?, loginPath? }
              basePath vaut /api/auth par défaut, ce à partir de quoi la console
              compose son callback. loginPath n'est lu qu'en doublure.

realtime      { path?, tickets? }
              path est ce que le NAVIGATEUR appelle sur cet hôte. tickets vaut la
              mémoire par défaut, ce qui est un bug le jour où il y a deux workers.

live          { enabled? }
              Suivre chaque compte pour lequel ce processus tient une session, et
              RELAYER ce qui arrive vers di.onAccount / di.onSignedOut. Aucun garde
              ne lit dedans.

di            tout ce qui est injecté. Voir plus bas.

logger        timeoutMs        retry { attempts?, delayMs? }
```

**Pas d'`identity`, pas de `declaration`, pas d'`exit`, pas de `policy`.** L'identité, l'URL de retour, l'URL d'annulation, le template et la barrière sont saisis sur la console de x-core à l'étape qui frappe le jeton d'installation, et l'appairage les rapporte dans le magasin de l'application. Les écrire ici en ferait une seconde source, et comme `declare()` les renvoie à chaque démarrage, l'application écraserait en silence ce qu'un opérateur a réglé.

### `di`, et rien d'autre n'est de l'injection

```
hmac.getCredential(clientId)          le hash courant, relu avant CHAQUE signature
hmac.setCredential(clientId, hash)    ranger ce que la file de propagation a porté
hmac.deleteCredential?(clientId)      facultatif

environment.load()                    tout, en une lecture, avant toute chose
environment.save(values)              upsert ce qui est donné, laisse le reste

local_accounts?                       une LISTE, lue seulement à mode: "local". Un
                                      enregistrement porte passwordHash - scrypt,
                                      produit par hashPassword
errors?(refusal, req, res)            comment CETTE application dit « refusé »
onAccount?(userId, me)                ce que live a poussé
onSignedOut?(userId)                  la session est terminée
```

Deux fonctions pour le credential, deux pour le magasin, et jamais le magasin lui-même : un objet passé à travers cette frontière est un objet que la librairie tient et dont elle dépend, donc le jour où le paquet de credentials renomme une méthode, toutes les applications qui l'utilisent attendent une release. Une fonction déplace la cassure dans le fichier de l'application, où c'est une ligne.

`errors` est la même règle appliquée aux refus. La librairie décide SI et POURQUOI - c'est la seule chose qui parle au fournisseur - et ceci dit COMMENT, parce que ça appartient au framework en dessous. Ne rien prêter et la librairie écrit la réponse simple elle-même.

## Ce qu'elle fait

```
start()                          lire le magasin, appairer si INSTALLED le dit, ouvrir
                                 la file de credentials, prouver l'adresse, déclarer.
                                 NE LÈVE JAMAIS : le résultat est un XcoreStartResult.
load()                           le magasin seul, pour un worker qui ne déclare pas
declare()                        la déclaration seule
close()                          chaque socket et la file, pour un processus qui sort

session(req, res)                le compte, ou null. Demande au fournisseur À CHAQUE FOIS
sessionOf(req, res)              pareil, en gardant le couple et l'id du compte
logout(req, res)                 fermer chez x-core, effacer le cookie, répondre où aller
jar(req, res)                    lire et écrire les cookies de cet échange

middleware.routes()              les six routes, et un passe-plat pour tout le reste
middleware.requireSession()      rien derrière n'est servi sans compte
middleware.requirePermissions()  refuse sauf si chaque action est détenue
middleware.errors()              le dernier gestionnaire de la chaîne
middleware.account(req, res, …)  pour un handler qui DEMANDE au lieu d'être enveloppé

realtime.ticket(accessToken)     en frapper un : 32 octets, 30 secondes, usage unique
realtime.attach(server)          accrocher le bridge sur un serveur HTTP existant
follow({ accessToken, … })       une socket à soi, suivant UN compte

permissions(req) actions(req) can(req, a) canAll(…) canAny(…) assert(…)
```

`sessionOf` est tout le côté serveur en un appel : il lit le cookie scellé, demande à x-core, fait tourner le couple si l'access token a expiré, re-scelle le nouveau, compare `portail` à `global`, et répond le compte sous la forme de [session.json](session.json) ou `null` si la session est terminée. **Il ne met jamais en cache.**

Que `start()` ne lève pas est délibéré plutôt que laxiste. Un démarrage qui mourrait parce qu'un jeton a été dépensé, parce que le broker n'était pas encore levé ou parce que le fournisseur démarrait encore emporterait toute l'application avec lui, y compris les pages qui n'ont rien à voir avec le SSO et y compris ce qu'un opérateur utiliserait pour regarder le problème.

## Comment elle se branche

Le cœur tourne sur les objets requête et réponse bruts de Node - pas de `res.json`, pas de `res.redirect`, pas de `req.query` - si bien que ce qui est au-dessus est un adaptateur plutôt qu'un port.

| Point d'entrée                               | Ce qu'il fournit                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@gestionpratique/node-sso-consumer`         | le bridge, le middleware, les gardes, le bridge realtime                                 |
| `@gestionpratique/node-sso-consumer/client`  | la moitié navigateur : la socket, le ticket, le backoff, le battement, les topics        |
| `@gestionpratique/node-sso-consumer/express` | déclare `req.me`, `req.ssoTokens` et `req.ssoUserId` sur le type de requête du framework |

Guides pour [Express](../../guides/fr/express.md), [NestJS](../../guides/fr/nestjs.md) et [Nuxt 4 / Nitro](../../guides/fr/nitro.md).

La moitié navigateur n'est pas facultative dans l'esprit : une application qui la saute n'a pas de temps réel, donc pas de révocation avant que quelqu'un clique.

## Ce qu'elle ne fera pas

Décider quoi que ce soit sur les données de l'application. La barrière qu'elle déclare dit qui peut entrer tout court ; qui peut toucher quelle facture est l'affaire de l'application, et l'a toujours été.

Posséder une page de connexion, une table d'utilisateurs, un mot de passe, un parcours de réinitialisation ou une table de sessions. C'est ce qu'elle remplace, pas ce qu'elle enveloppe. À `mode: "local"` elle authentifie contre une liste prêtée, et même là l'application ne possède que l'ÉCRAN : la comparaison, le scellement et la session sont à la librairie.

Ouvrir un Redis ou une base de données. On lui tend deux fonctions pour le credential et deux pour le magasin, et elle ne sait rien d'autre sur l'un ou l'autre. Elle ouvre **en revanche** la connexion au broker, parce qu'une file de propagation transporte des credentials et qu'aucune application consommatrice ne devrait avoir à en câbler une pour quelque chose qu'elle ne lit jamais elle-même.

Mettre en cache le compte, le profil ou les droits. Ni pour une requête, ni pour une seconde. C'est la garantie, pas un détail d'implémentation.

Parler à autre chose que x-core. Elle connaît les routes de x-core, son schéma HMAC, son catalogue et son protocole temps réel, et il n'existe aucune autre implémentation d'aucun des quatre. Pointée sur un fournisseur OAuth2 ou OIDC elle ne se dégrade pas, elle n'a simplement rien à qui parler.
