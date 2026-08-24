# Les permissions

x-core répond ce qu'un compte peut faire à chaque lecture de `GET /sso/me`, recalculé sur cette requête. Une application n'en stocke rien, et n'a aucune opinion propre sur qui peut faire quoi.

## La forme

```jsonc
"permissions": {
  "global": ["core:access", "example:view-records", "example:create-records", …],
  "isRoot": true,
  "groups": [{ "id": "…", "name": "…", "description": null }],
  "portail": ["example:access"]
}
```

`global` est une liste plate de chaînes `resource:action`. `resource` nomme une application ou un domaine de l'écosystème, `action` ce qui peut y être fait.

`groups` est **dans** `permissions` plutôt qu'à côté : c'est de là que viennent les droits, accordés par un groupe et nulle part ailleurs, si bien qu'un lecteur de l'un détient toujours l'autre.

`isRoot` est répondu en amont de la liste. Un compte root revient en détenant tout le catalogue, si bien qu'une recherche ordinaire le couvre déjà et qu'aucun contrôle n'a besoin de cas particulier. Il vaut la peine d'être lu pour une seule chose : une barrière ne doit jamais pouvoir enfermer root dehors de la console qui répare la barrière.

Un objet plutôt qu'un simple tableau parce que x-core y garde de la place pour un second étage. Lire `.global` fait qu'une clé ajoutée plus tard ne coûte rien de ce côté.

## Deux barrières, et ce ne sont pas les mêmes

**La porte**, déclarée une fois par l'application sous `dependGlobalRessource` et vérifiée par x-core : les ressources globales sur lesquelles un compte doit détenir `access` avant que x-core ne remette un code à cette application. Elle est revérifiée à chaque appel qui maintient la session en vie, `/sso/me` compris, si bien qu'un compte dont l'accès est révoqué cesse d'être répondu au prochain appel sans que ce côté-ci ne tienne de liste.

**Ce qui peut être fait une fois entré**, qui est l'affaire de l'application, page par page et route par route.

Une application qui déclare `["core"]` dit « détenir `core:access` suffit pour m'ouvrir ». Une application qui déclare `[]` dit « quiconque le SSO connecte peut entrer ». La liste est envoyée à chaque déclaration, vide ou non, parce qu'un champ optionnel omis n'est jamais écrit : l'omettre pourrait poser une barrière et ne jamais en retirer une.

### La porte, répondue en retour : `permissions.portail`

La barrière n'est pas seulement vérifiée là-bas. x-core répond ce que CETTE application exige à côté de ce que le compte détient, d'un même souffle, et la porte est alors une comparaison :

```
permissions.portail  ⊆  permissions.global
```

Les deux parlent `resource:action`, donc c'est un test d'inclusion sans rien à parser, découper ou préfixer. Un `portail` vide n'exige rien et admet tout le monde, ce qui est le cas courant et reste bon marché. Root n'a pas besoin d'exception : il revient en détenant tout le catalogue, donc l'inclusion tient par construction.

**Il arrive avec chaque `me` plutôt que d'être lu depuis quoi que ce soit gardé ici.** Il était lu depuis ce que l'appairage avait écrit dans le magasin propre à l'application, et un magasin est une copie : un opérateur qui ajoutait une exigence sur la console la changeait là-bas pendant que l'application continuait d'admettre qui elle admettait le jour de son installation.

La comparaison est faite des **deux** côtés, et ce sont deux travaux différents. Le serveur la fait à chaque lecture de session, et un échec termine la session ici et efface le cookie : le compte est connecté et n'a simplement pas le droit d'être dans cette application. La page la fait à chaque `me-changed` poussé, et un échec est une DÉCONNEXION plutôt qu'un repaint - perdre `<resource>:access` n'est pas un droit en moins, c'est la porte, et griser les boutons laisserait le lecteur assis sur une page que le serveur a déjà commencé à refuser.

## Afficher n'est pas appliquer

Tout ce qu'une page fait de cette liste consiste à **cacher ce que l'API refuserait de toute façon**. Cacher n'est pas appliquer, et ce sont deux travaux séparés qui se trouvent lire la même liste.

Le refus lui-même est un `403` du serveur, sur chaque route, contre les permissions que x-core a recalculées sur **cette** requête. Rien sur une page ne peut accorder quoi que ce soit, et une page qui ne cacherait rien serait simplement une page dont tous les boutons répondent `403`.

## Les trois questions qu'une page pose

```
can(action)        détient celle-ci
canAll(...actions) les détient toutes, ce que demande une page qui a besoin de deux droits
canAny(...actions) en détient au moins une, pour une section que plusieurs droits ouvrent
```

Une application dont les droits vivent tous sous une même ressource peut nommer cette ressource une fois et demander en forme courte, plutôt que de répéter le préfixe à chaque appel. C'est un confort du lecteur, pas une règle du protocole : ce que x-core répond est toujours le `resource:action` complet.

## Garder une route

Une page que personne ne peut ouvrir répond `403` plutôt que de s'ouvrir sur rien. Le menu cache déjà le lien et l'API refuse déjà les appels derrière, mais un lien caché n'est pas une porte fermée : l'adresse peut être tapée, mise en favori, ou suivie depuis un message. Sans garde, une telle page rend sa coquille, tire ses requêtes, et montre un écran cassé fait de refus au lieu de dire la seule chose qui est vraie.

Un `403` et jamais une redirection : le lecteur **est** connecté, donc l'envoyer au portail le ramènerait aussitôt avec les mêmes droits. Fatal, donc ça remplace la page plutôt que de rendre à côté, parce que ce qui est derrière est exactement ce qui ne doit pas être dessiné.

Déconnecté est un cas différent et ce n'est pas l'affaire de ce garde : c'est une redirection, décidée avant qu'il ne s'exécute.

Une page déclare ce dont elle a besoin et rien d'autre. Il n'y a pas de second endroit à penser quand on en ajoute une.

## La page déjà ouverte

Le garde s'exécute quand une route est entrée, ce qui laisse le cas qui compte le plus à découvert : un droit révoqué pendant que quelqu'un est **assis sur** la page qu'elle ouvre. La socket pousse le changement en quelques secondes, l'entrée de navigation disparaît, et le formulaire reste là à offrir une action que l'API refuse désormais.

La même question est donc reposée dès que la réponse peut avoir bougé : quand les droits changent, et quand la route change.

Deux détails qui n'apparaissent qu'à l'usage :

- **Réaccordé est aussi un changement.** Un droit rendu doit ramener la page plutôt que laisser quelqu'un sur une erreur que rien ne peut effacer sauf un rechargement.
- **Seul ce que ceci a levé est effacé.** Un `403` peut venir de n'importe où, et effacer celui qu'on n'a pas causé remettrait un lecteur sur une page dont le refus tient toujours.

Ceci appartient au navigateur seul : il s'agit d'une page déjà ouverte devant quelqu'un. Le premier rendu est le travail du garde.
