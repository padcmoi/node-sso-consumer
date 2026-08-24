# Les deux applications de référence

Tout ce dossier a été relevé sur deux applications qui parlent déjà ce protocole, sous deux formes différentes. Voici ce que chacune fait, où elles s'accordent, et laquelle est le modèle et laquelle l'héritage.

|                     | `manager-infra`                                    | `x-core/app_manager`                              |
| ------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Forme               | une API NestJS et une console Nuxt, deux processus | une application Nuxt, sa moitié serveur est Nitro |
| Session tenue par   | l'API                                              | le serveur Nitro                                  |
| L'interface parle à | l'API, à travers un relais                         | ses propres routes serveur                        |

## Étape par étape

| #   | Étape                     | `manager-infra`                                                                    | `app_manager`                                                                         |
| --- | ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Identité                  | clientId configuré                                                                 | clientId écrit dans le service                                                        |
| 2   | Credential                | livré par un broker dans son propre magasin, en réception seule                    | créé et tourné par l'application dans un magasin partagé avec x-core                  |
| 3   | Déclaration               | `PUT config`, 5 tentatives, 3 s d'écart, worker élu, **sonde d'abord**             | `PUT config`, 60 tentatives, 2 s d'écart, non attendue, pas de sonde                  |
| 4   | Entrée                    | `sso/start`, `sso_state` pour 10 min                                               | pareil, plus `sso_redirect` validé comme chemin de cette app                          |
| 5   | Callback                  | state comparé, code échangé avec l'adresse et l'agent du navigateur, couple scellé | identique                                                                             |
| 6   | En cas d'échec            | retour à l'entrée avec `?error=sso`                                                | identique                                                                             |
| 7   | Cookie                    | enveloppe scellée, porte le couple **et une session locale**                       | enveloppe scellée, porte le couple et l'id du compte                                  |
| 8   | État local                | **une table de sessions et une table de comptes**                                  | **aucun**                                                                             |
| 9   | Vivacité                  | `GET /sso/me` sur chaque route gardée                                              | `GET /sso/me` sur chaque route de données, déconnexion et lecture du compte exceptées |
| 10  | Expiration                | rotation une fois, réessai une fois                                                | identique                                                                             |
| 11  | Déduplication de rotation | clefée par refresh token                                                           | clefée par refresh token, **plus une relecture du cookie quand elle perd**            |
| 12  | Déconnexion               | fermer chez x-core, révoquer la ligne locale, effacer le cookie                    | fermer chez x-core, effacer le cookie                                                 |
| 13  | Ticket                    | 32 octets, magasin partagé, 30 s, GETDEL                                           | identique, octet pour octet                                                           |
| 14  | Bridge                    | sur le serveur HTTP de l'API, chemin comparé exactement                            | le gestionnaire WebSocket du framework                                                |
| 15  | Topics suivis             | `me-changed`, `me-signed-out`                                                      | les deux mêmes, **plus un registre** qui souscrit par page                            |
| 16  | Client vers serveur       | aucun                                                                              | `revoke`, depuis l'écran des sessions                                                 |
| 17  | Sur `me-signed-out`       | effacer l'état **et appeler la route de déconnexion**, puis partir                 | effacer l'état et partir ; le cookie meurt à la requête suivante                      |
| 18  | Reconnexion sur           | l'apparition de la session                                                         | l'apparition de la session, `online`, `focus`, `visibilitychange`                     |
| 19  | Sortie                    | le portail                                                                         | sa propre page de connexion                                                           |
| 20  | Permissions               | forme courte sous une ressource                                                    | `resource:action` complet, avec `isRoot` lu explicitement                             |
| 21  | Page déjà ouverte         | revérifiée quand les droits changent                                               | non couvert                                                                           |

## Ce sur quoi elles divergent, et qui a raison

**État local (ligne 8).** `app_manager` ne tient rien, ce qui est le modèle ([03-session-model.md](03-session-model.md)). `manager-infra` porte encore une table de sessions avec sa propre fenêtre d'accès et sa propre chaîne de rafraîchissement, et une table de comptes. Son propre code dit que la migration n'est pas finie : il n'y a plus de connexion locale, et une session ne portant pas de couple x-core est déjà refusée d'emblée. **La librairie implémente la première et laisse tomber la seconde.** Une session locale est précisément ce qui ne peut pas honorer une révocation, puisqu'elle serait encore valide.

**Déduplication de rotation (ligne 11).** `app_manager` relit le cookie quand sa rotation perd, et il a raison : perdre une rotation n'est pas la preuve que la session est terminée, un autre worker peut l'avoir gagnée. La version de `manager-infra` laisse un cluster à découvert.

> **La librairie a pris celle de `manager-infra`.** Elle déduplique dans le processus, clefée par le refresh token, et lit une rotation refusée comme une session terminée - juste sur un processus, et sur plusieurs elle déconnecte un lecteur dès que deux workers courent après le même token expiré. La relecture est ce qui fermerait ça, et elle n'est pas là. Écrit noir sur blanc plutôt que discrètement retiré du tableau, parce que ce fichier est ce qu'on lit pour savoir ce qui a été décidé.

**La sonde (ligne 3).** Seul `manager-infra` vérifie que l'adresse est bien x-core avant de lui déclarer quoi que ce soit. C'est la seule protection contre l'échec silencieux que ce protocole invite. **La librairie la garde, pour tout le monde.**

**Se déconnecter via la socket (ligne 17).** `manager-infra` appelle sa propre route de déconnexion, qui efface le cookie scellé et ferme la session chez x-core séance tenante. `app_manager` laisse le cookie mourir à la requête suivante, ce qui marche parce que son garde lit le compte à chaque navigation. **La librairie prend l'explicite :** elle ne doit pas dépendre de quelqu'un qui navigue.

**Reconnexion et page déjà ouverte (lignes 18 et 21).** Chaque application couvre quelque chose que l'autre ne couvre pas. **La librairie prend l'union.**

**Registre de topics et `revoke` (lignes 15 et 16).** Celui de `app_manager` est un sur-ensemble des deux topics fixes de `manager-infra`. **La librairie prend le registre**, avec TROIS topics toujours actifs en dehors : `me-sessions` a rejoint les deux, parce que c'est le seul qui rapporte une session coupée depuis l'écran des connexions.

## Ce qui doit devenir de la configuration

Rien dans la liste ci-dessus n'est de la logique. Ce sont les seules vraies différences entre les deux intégrations, et chacune devient une valeur :

```
identité              le clientId sous lequel cette application signe
fournisseur           la base API, la fenêtre de connexion, le port de la socket
accès credential      comment lire le hash courant, et comment en ranger un
magasin de tickets    où vit un ticket de 30 secondes à usage unique
routes                où répondent l'entrée, le callback, la déconnexion et le ticket
déclaration           callback, URL d'annulation, template de connexion, barrière d'accès
cookie                son nom, son scellement, si Secure s'applique
sortie                où atterrit un navigateur déconnecté
élection              si ce worker est celui qui déclare
politique de vivacité quels chemins sont contrôlés
```

Tout le reste est le même code deux fois, et c'est à ça que sert la librairie.

## Ce que la librairie ne prend ni à l'une ni à l'autre

La plomberie propre au credential. L'une le reçoit par un broker, l'autre l'écrit dans un magasin partagé avec x-core, et les deux sont des topologies de déploiement plutôt que du protocole. La librairie **lit un hash et demande qu'on en range un**, et ne sait rien d'où vient l'un ou l'autre ([08-library-contract.md](08-library-contract.md)).

Le proxy interne avec lequel l'une signe ses propres appels d'API, les tables que l'autre garde pour ses clés d'API et ses invitations, et les pages, menus et écrans des deux.
