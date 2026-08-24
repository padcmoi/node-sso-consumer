# Faire tourner plusieurs processus

Tout ce qui suit porte sur une seule chose : trois morceaux de cette librairie gardent un état en mémoire, et la mémoire est par processus. Un processus n'a besoin d'aucun d'eux. Plusieurs - un cluster, quelques réplicas derrière un relais, ou un serveur de dev qui recharge à chaque changement - ont besoin des trois.

## 1) Un seul worker déclare, pas tous

L'élection appartient au DÉPLOIEMENT, pas à cette librairie : elle ne sait rien de PM2, du
nombre de workers, ni de leur numérotation. Elle expose donc deux appels au lieu d'un, et
la garde vit dehors.

```ts
// Chaque worker : lire le magasin. Sans ça aucun ne sait sous quel nom il signe,
// quel cookie il ouvre, ni ce qu'il déclare.
await xcore.load();

// Un seul worker : appairer s'il le faut, et déclarer.
if (process.env.NODE_APP_INSTANCE === "0") await xcore.start();
```

`start()` fait `load()` lui-même, donc une application mono-processus l'appelle seul et rien
d'autre.

Déclarer est idempotent, donc plusieurs workers qui déclarent la même chose sont du bruit
plutôt qu'une faute. **L'appairage ne l'est pas.** Le code d'installation est à usage unique :
un second worker qui court après le premier est refusé, et son démarrage échoue sur un
credential que le premier a déjà écrit. Cette course n'existe qu'au tout premier démarrage
d'une application neuve - ensuite `INSTALLED` vaut vrai et aucun worker ne regarde plus le code.

Un worker non élu ne doit PAS renoncer à démarrer : la déclaration qu'il a sautée est celle
qu'un autre worker est en train de faire, et tout ce qu'il lui faut pour servir est sorti de `load()`.

## 2) Un ticket frappé n'importe où doit être dépensable n'importe où

```ts
import type { TicketStore } from "@gestionpratique/node-sso-consumer";

const tickets: TicketStore = {
  put: (ticket, accessToken, ttl) => redis.set(`sso:ticket:${ticket}`, accessToken, "EX", ttl),
  // Lire ET supprimer en un seul geste, ou un ticket lu deux fois est un ticket rejoué.
  take: (ticket) => redis.getdel(`sso:ticket:${ticket}`),
};

createXcoreBridge({ /* ... */ realtime: { tickets } });
```

La page demande un ticket à un worker par un XHR ordinaire, puis ouvre une socket - que le relais est libre d'envoyer à un autre. Avec le magasin mémoire par défaut, ce second worker n'a jamais entendu parler du ticket et ferme en `4402`, le navigateur en redemande un, et la boucle est stable et silencieuse.

`getdel` compte : un `get` suivi d'un `del` fait deux allers-retours avec une fenêtre entre les deux, et c'est la fenêtre où vit un rejeu.

La même chose vaut pour un serveur de dev qui redémarre à chaque changement - le processus qui détient le ticket a disparu au moment où la socket arrive.

## 3) Les comptes suivis sont par processus, et c'est très bien

`SsoLiveAccounts` tient une socket par compte, dans le worker qui a résolu une requête pour lui. Quatre workers qui tiennent une session pour le même lecteur tiennent quatre sockets, et chacune est corrigée par le fournisseur dans les secondes qui suivent le moindre changement.

Il n'y a rien à partager ici et rien à configurer. Ce que ça coûte est une socket par compte et par worker ; ce que ça achète est `di.onAccount` et `di.onSignedOut` qui se déclenchent en quelques secondes plutôt qu'au prochain clic de quelqu'un. Une application qui n'a rien à tenir à jour le coupe :

```ts
createXcoreBridge({ /* ... */ live: { enabled: false } });
```

Le couper ne change rien à qui entre. **Aucun garde ne lit dedans, dans aucun worker.** Chaque lecture demande au fournisseur, donc quatre workers s'accordent parce qu'ils demandent tous au même côté, pas parce qu'ils partagent quoi que ce soit.

## 4) Ce qui n'a besoin de rien

Le cookie scellé. Il porte la session entière - l'id du compte et le couple de tokens - donc n'importe quel worker le lit sans rien demander à un autre, et il n'y a pas de magasin de sessions à partager, à faire expirer ou à migrer. C'est la raison pour laquelle il n'y a pas de Redis dans la liste ci-dessus pour la session elle-même.

## 5) La rotation, et la limite de ce montage

C'est le point à connaître avant de multiplier les workers.

La déduplication des rotations est **par processus** : la table des rotations en vol vit dans le worker qui la détient. Sur un processus elle a vu toutes les rotations qu'il y a eu, donc une rotation refusée signifie vraiment que le refresh token est dépensé et effacer le cookie est juste.

Sur plusieurs, un autre worker peut avoir gagné la rotation, ce qui invalide cette copie du refresh token alors que la session reste vivante - et ce côté-ci lit ça comme une session terminée. En pratique un lecteur est déconnecté dès que deux workers courent après le même token expiré, ce que produit un onglet qui reprend le focus.

Il n'y a rien à partager pour fermer ça : la relecture du cookie qui le fermerait n'est pas implémentée. Les deux issues sont donc de garder à un seul le nombre de processus qui résolvent des sessions, ou d'accepter la reconnexion forcée occasionnelle. Voir [04-lifecycle.md](../../specs/fr/04-lifecycle.md).
