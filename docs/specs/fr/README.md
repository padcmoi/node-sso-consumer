# Le consumer SSO x-core, spécifié

Ce qu'une application doit faire pour **être** consommatrice du SSO x-core. Écrit avant que quoi que ce soit n'en soit implémenté sous forme de librairie, et gardé depuis comme la raison derrière ce que la librairie fait.

Rien ici n'est conçu. Chaque règle ci-dessous a été relevée sur trois sources et est citée avec son origine, si bien qu'un désaccord entre ce dossier et le code est un bug de ce dossier :

| Source                                                       | Ce qu'elle tranche                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `x-core/src/api/v1/sso/**` et `x-core/src/core/websocket/**` | le protocole, des deux côtés. C'est l'autorité et la seule implémentation                      |
| `manager-infra/` (API NestJS + console Nuxt, deux processus) | une forme d'intégration : la session vit dans une API, l'interface est une application séparée |
| `x-core/app_manager/` (Nuxt + Nitro, un processus)           | l'autre forme : la session vit dans la moitié serveur du framework                             |

Les deux applications implémentent deux fois le même protocole. Ce qui diffère entre elles n'est jamais la logique : c'est une identité, une adresse de magasin, un chemin de route, une URL de sortie. C'est toute la raison pour laquelle une librairie est possible, et la liste de ce qui doit devenir configuration est dans [07-reference-apps.md](07-reference-apps.md).

## Les spécifications

| #   | Fichier                                           | Ce qu'il couvre                                                                                  |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 01  | [protocol-http.md](01-protocol-http.md)           | la surface HTTP signée : schéma de signature, chaque route, chaque charge utile                  |
| 02  | [protocol-realtime.md](02-protocol-realtime.md)   | la passerelle WebSocket : handshake, frames, topics, latence, codes de fermeture                 |
| 03  | [session-model.md](03-session-model.md)           | la session vit dans x-core. Ce que l'application tient, c'est un cookie                          |
| 04  | [lifecycle.md](04-lifecycle.md)                   | déclaration au démarrage, aller-retour de connexion, vivacité par requête, rotation, déconnexion |
| 05  | [consuming-realtime.md](05-consuming-realtime.md) | le ticket, le bridge et le client navigateur qu'il faut pour le recevoir                         |
| 06  | [permissions.md](06-permissions.md)               | les droits que x-core répond, et ce qu'une application peut ou non en faire                      |
| 07  | [reference-apps.md](07-reference-apps.md)         | ce que font les deux applications, étape par étape, et où elles divergent                        |
| 08  | [library-contract.md](08-library-contract.md)     | la surface exposée par la librairie, et ce qu'elle refuse de posséder                            |
| 09  | [invariants.md](09-invariants.md)                 | les règles qu'on ne peut pas casser, et ce que casser chacune donne                              |

[session.json](session.json) est la charge utile sous laquelle le compte se lit. Chaque document qui nomme un champ désigne un champ de ce fichier. **Les valeurs qu'il contient sont inventées** : c'est la forme qu'il documente, et une capture réelle n'a rien à faire dans un paquet publié.

## Trois endroits où le terrain appartient à l'application

La librairie existe maintenant, et elle trace sa limite en deçà de trois règles écrites ici. Cette limite est là où elle est volontairement, et chaque document dit ce que la librairie fait plutôt que ce qu'elle manque de faire. Les règles restent, parce qu'elles restent les règles contre lesquelles doit écrire celui qui couvre ce terrain.

| Terrain                                         | Où                                                                        | Ce que fait la librairie                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le chemin de retour après une connexion         | [04](04-lifecycle.md), [09](09-invariants.md)                             | n'en garde aucun, et fait atterrir toute connexion sur `routes.afterLogin`. Une application qui veut le lien profond le stocke, et en assume la validation                |
| Une rotation perdue au profit d'un autre worker | [04](04-lifecycle.md), [07](07-reference-apps.md), [09](09-invariants.md) | déduplique dans le processus et lit une rotation refusée comme une session terminée. Juste sur un processus ; sur plusieurs, elle force une reconnexion de temps en temps |
| Où attend un ticket realtime                    | [05](05-consuming-realtime.md), [09](09-invariants.md)                    | le garde en mémoire, ce qui est juste pour un processus. Au-delà, on lui tend un magasin partagé par `realtime.tickets`                                                   |

Deux choses sont arrivées après la première écriture de ces documents et y sont intégrées : `permissions.portail`, qui est la porte répondue avec chaque `me` ([06](06-permissions.md)), et `me-sessions`, le troisième topic toujours actif, qui rattrape la fin de session que les deux autres ne peuvent pas rapporter ([05](05-consuming-realtime.md)).

## Où aller pour le comment, plutôt que pour le pourquoi

Ce dossier dit ce qu'est le protocole et pourquoi. [Le fichier de service](../../guides/fr/service.md) dit comment l'écrire, clé par clé, avec ce que contient le magasin. Les [guides d'intégration](../../guides/fr/) disent comment le monter sous Express, NestJS et Nitro, et les [diagrammes de séquence](../../diagrams/) dessinent la socket de bout en bout.

## La phrase que tout le reste développe

Une application qui consomme ce SSO ne tient **aucune table d'utilisateurs, aucune table de sessions, aucune table de permissions, aucun mot de passe, aucune page de connexion et aucun cache**. Elle tient un cookie scellé portant un couple de tokens émis par x-core, elle demande à x-core qui est le lecteur à chaque requête, et elle garde un WebSocket ouvert toute la session pour qu'un changement fait dans une autre application arrive en quelques secondes plutôt qu'au prochain clic.
