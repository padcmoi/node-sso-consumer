# Les invariants

Les règles qu'on ne peut pas casser, chacune avec ce que la casser donne. La plupart ont déjà été payées une fois.

Trois d'entre elles appartiennent à l'application plutôt qu'à cette librairie, et chacune le dit là où elle est : le chemin de retour et sa validation, que cette librairie ne garde pas du tout ; la relecture du cookie quand une rotation perd, qu'elle ne fait pas ; et le magasin de tickets, qui n'est partagé que si un déploiement en tend un. Ce que la librairie fait est écrit sous chacune - la règle reste, parce qu'elle reste la règle contre laquelle doit écrire celui qui couvre ce terrain.

## Les credentials

**Le secret n'entre jamais dans cette librairie, et le hash est relu à chaque appel.** Un signataire fabriqué une fois au démarrage continue de signer avec un credential qu'une rotation a déjà remplacé : chaque appel répond `401`, le clientId existe toujours et le magasin a l'air parfaitement sain.

**Le poivre doit être la valeur propre à x-core.** Un poivre différent transforme un credential parfaitement arrivé en `401` sur chaque appel, indiscernable d'un credential qui n'est jamais arrivé.

**Un credential manquant n'est pas un mauvais credential.** « Rien n'a encore été propagé » est un état au démarrage, pas une panne, et ça mérite sa propre phrase dans le journal. Sinon la chasse commence contre la signature au lieu de commencer contre la file.

## Les adresses

**Sonder avant de déclarer.** La fenêtre de connexion répond `204` à tout ce qu'elle ne connaît pas, donc une application pointée dessus se déclare avec succès à chaque démarrage alors que rien n'existe en face. L'appel non signé qui doit être refusé `401` est la seule protection.

**Une déclaration ratée doit être bruyante.** Une application qui a raté sa déclaration démarre parfaitement et refuse ensuite toutes les connexions. C'est l'échec qui coûte un après-midi.

**Ne jamais deviner le callback depuis un en-tête de requête.** Il est dérivé de l'adresse configurée, ou il n'y a pas d'adresse à enregistrer.

## L'aller-retour

**Aucun `redirect_uri` dans une query, jamais.** x-core le résout depuis la déclaration. Une cible qui voyage dans une query de navigateur est une redirection ouverte.

**Un chemin de retour est validé comme un chemin de cette application.** Une seule barre oblique en tête, jamais `//hôte`, jamais les routes de connexion elles-mêmes. Un chemin stocké et une query sont tous deux du texte contrôlé par un attaquant.

> **Ce que fait la librairie :** elle ne garde aucun chemin de retour et envoie chaque connexion sur `routes.afterLogin`. Il n'y a rien à valider parce qu'il n'y a rien de stocké. Une application qui en ajoute un emporte cette règle avec.

**Transmettre l'adresse et l'agent du navigateur**, à l'ouverture **et** à chaque rotation. Sans ça x-core classe la session sous le conteneur appelant, et c'est ce que son propriétaire lit sur l'écran des sessions du portail.

**Une connexion ratée revient à l'entrée, pas sur une page d'erreur.** Un code réutilisé, un code expiré ou un cookie perdu sont tous des choses qu'un lecteur devrait pouvoir simplement réessayer.

## La session

**L'application ne tient rien.** Une ligne de session locale est une session qui survit à une révocation, ce que ce modèle existe précisément pour empêcher.

**Rien n'est mis en cache, pas même pour une requête.** Le compte, le profil et les droits sont demandés à chaque requête. C'est la garantie.

**Une session ne portant aucun couple de tokens est refusée d'emblée**, pas tolérée. C'est un cookie d'une forme plus ancienne, et l'honorer est un accès forcé.

**Le nom du cookie est dérivé de l'identité.** Deux applications sous un même hôte qui écrivent le même nom se déconnectent l'une l'autre à chaque navigation, en silence, puisque du point de vue de chacune le cookie est simplement absent.

**`Secure` est réservé à la production.** Un cookie Secure est jeté par le navigateur sur le HTTP nu que sert le développement, ce qui se lit comme « la session ne s'ouvre jamais ».

**Pas de ttl sur le scellement.** x-core fait expirer la session ; une seconde horloge ne peut que contredire la première.

**Le mot de passe de scellement appartient à l'application.** Deux applications qui le partageraient pourraient ouvrir les cookies l'une de l'autre.

## La rotation

**Les rotations concurrentes partagent un seul résultat.** La rotation est à usage unique : sans déduplication la seconde requête dépense un token que la première a consommé, et une session parfaitement vivante meurt. Ça arrive sur chaque onglet qui reprend le focus, pas rarement.

**Perdre une rotation n'est pas la preuve que la session est terminée.** Relire le cookie : un token différent est la victoire d'un autre worker, et la session est vivante.

> **Ce que fait la librairie :** elle déduplique dans le processus et lit une rotation refusée comme une session terminée. Juste sur un processus ; sur plusieurs elle déconnecte un lecteur dès que deux workers courent après le même token expiré.

**Le nouveau couple doit être re-scellé sur chaque réponse qui l'a attendu.** Quelle que soit la réponse qui atteint le navigateur en dernier, c'est elle qui décide de ce qu'il garde.

**Un seul réessai, jamais une boucle.** Une expiration est invisible après une rotation ; une révocation fait aussi échouer la rotation, et alors c'est terminé.

## La socket

**La page ne détient jamais de credential.** Un WebSocket n'est pas soumis à la politique de même origine, donc le cookie ne doit pas être ce qui en ouvre un. Un ticket, 30 secondes, usage unique, lu-et-supprimé, dans un magasin **partagé**.

> **Ce que fait la librairie :** le ticket, ses 32 octets, ses 30 secondes et son usage unique sont tous appliqués. Le magasin vaut la mémoire par défaut, ce qui est juste pour un processus - un déploiement qui en a plus en tend un partagé par `realtime.tickets`.

**La frame `auth` venant d'une page est refusée.** Elle nomme le compte, et c'est décidé par le ticket qui a ouvert la socket.

**L'identité est envoyée avant tout le reste.** x-core ferme une socket qui ne s'est pas authentifiée sous cinq secondes.

**Les codes de fermeture sont mappés.** `1000` et `4xxx` passent, tout le reste devient `1011` : `1006` et ses voisins appartiennent au runtime et ne peuvent pas légalement être renvoyés. Un client incapable de distinguer « reconnecte-toi » de « le réseau a cligné » réessaie éternellement ou abandonne à tort.

**Les frames envoyées avant que l'amont soit ouvert sont mises en file.** La page souscrit dès que sa propre socket s'ouvre, ce qui est en premier.

**Le contrôle de silence ne s'exécute que si l'onglet est visible.** Les timers d'arrière-plan sont bridés à environ un déclenchement par minute, donc il lirait un silence qui n'a pas eu lieu et raccrocherait une socket saine, exactement quand un changement poussé compte le plus.

**Un chemin de socket est comparé exactement.** Un chemin qui est le préfixe d'un autre signifie deux gestionnaires répondant à un upgrade, le second levant depuis une promesse impossible à attraper, et le worker redémarre aussi longtemps que quelqu'un ouvre cette page.

**Les trois topics toujours actifs, ou aucun.** Un état alimenté par `me-changed` seul est un cache, et un compte révoqué garde les derniers droits qu'on lui a poussés. `me-signed-out` est ce qui le démolit, et `me-sessions` est ce qui rattrape la fin de session qu'aucun des deux autres ne rapporte : une session coupée depuis l'écran des connexions, qui ne bouge ni la session IdP ni l'accès du compte.

**Une frame qui arrive après une déconnexion ne doit pas remettre un compte.**

## Les droits

**Cacher n'est pas appliquer.** La page cache ce que l'API refuserait ; l'API refuse. Les deux travaux existent, et aucun ne remplace l'autre.

**`dependGlobalRessource` est envoyé à chaque déclaration, vide ou non.** Un champ optionnel n'est écrit que s'il est fourni, donc l'omettre peut poser une barrière et ne jamais en retirer une.

**Une page refusée répond `403`, jamais une redirection.** Le lecteur est connecté ; l'envoyer au portail le ramène aussitôt avec les mêmes droits.

**La page déjà ouverte est revérifiée quand les droits changent.** Un garde s'exécute à l'entrée, et le cas qui compte est quelqu'un assis sur la page quand le droit disparaît.

**Ne jamais exposer le couple de tokens à une page.** Un refresh token est un mot de passe qui vit un mois, et tout ce qu'une page peut lire, tout ce qui tourne sur cette page peut le prendre.
