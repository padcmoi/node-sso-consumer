# Le cycle de vie

Cinq moments, du démarrage d'un processus à un lecteur déconnecté par une autre application. Tout ici est côté serveur ; la moitié navigateur est dans [05-consuming-realtime.md](05-consuming-realtime.md).

## 1. Démarrage : déclarer, puis servir

À chaque démarrage, une fois, l'application déclare à x-core comment elle se branche :

```
PUT /api/v1/sso/consumer/config
{ redirectUri, cancelUri, template, dependGlobalRessource: [] }
```

Idempotent, clefé par l'identité signante, si bien que rien n'est enregistré à la main et que déplacer un callback est un déploiement plutôt qu'une opération.

**Sonder d'abord.** Un `PUT /sso/consumer/config` non signé doit être refusé avec `401`. Tout le reste signifie que l'adresse n'est pas x-core, et rien n'est déclaré : un `204` venu d'autre chose se lit comme un succès, et l'application démarre alors parfaitement puis refuse toutes les connexions ensuite ([01-protocol-http.md](01-protocol-http.md)).

**Réessayer, bruyamment.** Le credential peut arriver par un broker au cours du même démarrage, et l'API du fournisseur n'écoute pas à l'instant où son conteneur existe. Une première tentative qui tombe sur un port fermé est le cas ordinaire, pas l'exception. La déclaration réessaie donc sur tout ce qui ressemble à « pas encore levé », échoue vite sur un `4xx` (c'est la charge utile de ce côté qui est fausse, et aucune attente ne répare ça), et le dit dans le journal si elle n'aboutit jamais. Une déclaration ratée en silence, c'est un après-midi à remonter jusqu'à une connexion qui répond 404.

**Un seul worker déclare.** Plusieurs enverraient le même `PUT` idempotent, ce qui est inoffensif et reste du bruit dans l'audit de x-core. L'élection appartient au déploiement, qui sait combien il y a de workers et comment ils sont numérotés ; la librairie prend la réponse, elle ne la calcule pas.

**Jamais attendu par le démarrage.** Un enregistrement qui peut légitimement prendre une minute ne doit pas être ce qui décide si le serveur écoute.

## 2. Connexion : l'aller-retour

L'application offre une seule entrée et aucun écran de connexion. Elle ne connecte personne ; le portail le fait, et c'est la seule chose qui le fait.

```
GET <app>/…/sso/start
  set-cookie  <cookie de session>_state=<uuid>   httpOnly, secure, lax, path=/, 10 min
  302 -> <ssoFront>/authorize?consumer=<clientId>&state=<uuid>
```

Le cookie d'état est nommé d'après le cookie de session, lui-même dérivé de l'identité : deux applications sous un même hôte ne peuvent pas plus se télescoper dessus que sur la session elle-même.

`state` est la protection CSRF de l'aller-retour et rien d'autre : comparé au retour, puis jeté. `lax` pour qu'il survive à la redirection de retour.

**Aucun `redirect_uri` ne voyage.** x-core le résout depuis la déclaration, ce qui rend une redirection ouverte impossible.

**Rien d'autre n'est mémorisé.** Le cookie d'état est tout ce que l'aller-retour porte, et toute connexion réussie atterrit sur `routes.afterLogin`. Un lecteur qui a suivi un lien profond arrive sur la page d'accueil de l'application plutôt que là où il allait.

C'est un plancher délibéré plutôt qu'un oubli : l'alternative est un chemin stocké, et un chemin stocké est du texte contrôlé par un attaquant. Une application qui veut le lien profond en retour le garde elle-même, et assume la validation qui va avec - une seule barre oblique en tête, jamais `//hôte` (une URL protocol-relative qui mène hors du site), et jamais les routes de connexion elles-mêmes, qui relanceraient l'aller-retour que ceci termine. Gardé de ce côté et jamais transporté à travers x-core : une cible qui voyage dans une query entre deux hôtes est une cible que n'importe qui peut réécrire.

```
GET <app>/…/sso/callback?code=&state=
  comparer le state au cookie, effacer le cookie d'état
  POST /api/v1/sso/consumer/session { code, clientIp, clientUserAgent }
  sceller le couple dans le cookie de session
  302 -> routes.afterLogin, ou /?error=sso si quoi que ce soit a échoué
```

`clientIp` et `clientUserAgent` sont ceux du **navigateur**, transmis explicitement : l'échange est un appel de serveur à serveur, donc x-core enregistrerait sinon ce conteneur comme le lecteur, et c'est ce que le propriétaire du compte lit sur l'écran des sessions du portail.

**Chaque échec ramène à l'entrée**, jamais sur une page d'erreur : un state manquant, un state qui ne correspond pas, un code déjà dépensé ou expiré sont tous des choses qu'un lecteur devrait simplement pouvoir réessayer. Un cookie perdu est une reprise, pas un incident.

## 3. Chaque requête : la vivacité

Une session consommatrice ne peut pas survivre à la session SSO dont elle descend. Donc sur chaque requête qui en porte une :

```
lire le cookie -> GET /sso/me?accessToken=…
  répondu   -> le lecteur est là, avec le compte que cette requête utilisera
  refusé    -> faire tourner une fois, réessayer une fois
  refusé    -> la session est terminée. Effacer le cookie.
```

Aucun cache entre les deux, jamais. C'est tout le sens de « aucun consumer ne survit à la session SSO » : un cookie encore dans une fenêtre qui lui est propre ne vaut rien si le compte s'est déconnecté au portail ou a perdu son accès, et demander est la seule façon de savoir, parce que rien là-bas ne rappelle.

Une session ne portant **aucun** couple de tokens est refusée d'emblée plutôt que tolérée. Il n'y a plus moyen d'en ouvrir une sans x-core, donc ce qui en détient une est un cookie scellé par une forme plus ancienne, et l'honorer est exactement l'accès forcé que ce contrôle existe pour fermer. Son porteur se reconnecte, ce qui coûte un clic.

Quelles requêtes sont contrôlées est une politique, pas une règle : une application contrôle les routes qui servent des données, et les requêtes de page atteignent la même garantie par les données qu'elles chargent. La route de déconnexion doit rester joignable avec une session que x-core a déjà lâchée, sinon le cookie local ne pourrait jamais être effacé. La route qui résout le compte est ce même contrôle, donc l'exécuter deux fois pour une requête est du gaspillage.

## 4. La rotation, et le piège dedans

L'access token est de courte durée, donc un refus est **d'abord traité comme une expiration** : faire tourner le couple et réessayer une fois. Une vraie révocation fait aussi échouer la rotation, et alors la session est terminée pour de bon. C'est ce qui rend une expiration invisible et une révocation immédiate, avec un seul chemin de code.

La rotation est à usage unique : x-core invalide le refresh token présenté et émet un nouveau couple.

**Les appelants concurrents doivent partager une seule rotation.** Une page qui charge deux ressources d'un coup détient le même cookie deux fois, donc le même refresh token deux fois. Sans déduplication le second appel dépense un token que le premier a déjà consommé, est refusé, et la session est effacée alors qu'elle est parfaitement vivante. Ça arrive constamment plutôt que rarement : chaque onglet qui reprend le focus tire plusieurs requêtes dès que l'access token a expiré. Les rotations en vol sont donc clefées par le refresh token dépensé, et tous ceux qui attendent reçoivent le résultat unique.

**La déduplication est par processus, et une rotation refusée termine la session.** La table des rotations en vol vit dans le worker qui la détient, donc sur UN processus elle a vu toutes les rotations qu'il y a eu : un refus là-bas signifie vraiment que le refresh token est dépensé pour de bon, et effacer le cookie est la bonne réponse.

Sur plusieurs workers, ce n'est pas le cas. Un autre worker peut avoir gagné la rotation, ce qui invalide cette copie du refresh token alors que la session reste parfaitement vivante - et ce côté-ci lit ça comme une session terminée. En pratique ça déconnecte un lecteur dès que deux workers courent après le même token expiré, ce que produit un onglet qui reprend le focus.

**Donc un déploiement qui fait tourner plusieurs workers d'une même application ne partage rien ici et ne le peut pas.** Ce qu'il peut faire est de garder à un seul le nombre de processus qui résolvent des sessions, ou d'accepter la reconnexion forcée occasionnelle. Voir [Plusieurs processus](../../guides/fr/multi-process.md).

**Le nouveau couple doit être re-scellé**, sur chaque réponse qui l'a attendu, ou la session meurt à l'appel suivant. Quelle que soit la réponse qui atteint le navigateur en dernier, c'est elle qui décide de ce qu'il garde.

## 5. Déconnexion

```
DELETE /api/v1/sso/consumer/session { refreshToken }   au mieux
effacer le cookie                                      toujours
```

Un échec là-bas ne vaut pas la peine de refuser une déconnexion : le cookie est effacé de toute façon et ce qui reste expire tout seul. Fermer proprement est ce qui empêche l'écran des sessions du portail de lister une session que plus personne ne détient.

Ceci termine la session **de cette application** uniquement. La session SSO dont elle descend reste ouverte, volontairement, et le lecteur reste connecté au portail et aux autres applications. L'inverse n'est pas symétrique, et c'est le but : fermer la session SSO ferme celle-ci aussi, parce que celle-ci en descend.

Où va le navigateur ensuite est une adresse unique, et c'est la même sortie vue de trois côtés : un lecteur qui se déconnecte, une session refusée parce qu'elle est terminée, et une session révoquée depuis ailleurs atterrissent tous sur le portail, qui est la seule chose dans cet écosystème qui connecte un humain. Une application avec sa propre page de connexion les y envoie à la place. C'est de la configuration, et c'est la seule raison pour laquelle ce n'est pas écrit ici.
