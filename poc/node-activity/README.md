# POC node-activity : `activity.publish` arrive jusqu'à x-core

Un conteneur, un script, un verdict. Il prouve qu'une publication d'activité faite par
la librairie **part, signée, et arrive à x-core**, et dit mot pour mot ce que x-core a
répondu.

Pas d'application, pas de page, pas de base : la librairie tourne ici comme une
application la fait tourner - compilée depuis `src/` dans l'image, importée depuis
`dist/`, pilotée par `createXcoreBridge` - et rien d'autre.

## Ce que le script fait

1. **Ce que font le navigateur et app_sso**, faute de navigateur dans un conteneur :
   connexion d'un compte de test, puis un grant pour l'application `CONSUMER`. C'est
   la seule partie écrite à la main.
2. **La librairie, à partir du code** : l'échange du code (`auth.openSession`, signé,
   comme la route de callback), puis `activity.publish` sur une requête qui porte la
   paire prouvée, comme derrière `requireSession()`.
3. **Le même appel en mode `"local"`** : rien ne doit partir.
4. **Rien laissé ouvert** : la session de l'application, puis celle de l'IdP.
5. **Le verdict** : ce qui est parti (adresse, verbe, identité signataire, en-têtes,
   corps avec le jeton tronqué), la réponse de x-core, et `PASSED` si le message est
   arrivé et que le mode local n'a rien envoyé. Le conteneur sort avec ce code.

Un x-core qui n'a pas encore `POST /api/v1/sso/consumer/activity` répond `404`, et le
verdict reste `PASSED` : le message est arrivé, rien ne le traite encore. La
librairie répond alors `{ published: false }` sans rien jeter, ce qui est son
contrat.

## Lancer

```bash
cp .env.sample .env    # puis le remplir : jamais commité
npm run prove          # construit l'image, lance, sort avec le verdict
npm run down           # retire le conteneur, le réseau et l'image
```

## Ce que `.env` doit dire

| clé                                | ce que c'est                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `XCORE_API`                        | l'API d'UN x-core, avec son port                                                                                                             |
| `XCORE_FRONT`                      | sa fenêtre de connexion                                                                                                                      |
| `CONSUMER`                         | une application où le compte peut entrer, par son identifiant consumer                                                                       |
| `READER_EMAIL` / `READER_PASSWORD` | un compte de **test**, jamais celui d'une personne réelle, qui détient la barrière de l'application                                          |
| `READER_IP`                        | facultatif : d'où le lecteur se connecte. Vide, x-core mesure la connexion depuis l'adresse du conteneur, qui peut lui paraître inhabituelle |
| `HMAC_HASH`                        | facultatif : le hash avec lequel l'application signe. Un x-core de développement ne vérifie pas les signatures ; tout autre exige le vrai    |

Un compte à qui x-core demande un code (second facteur, connexion inhabituelle) arrête
le script avant la librairie, avec un message qui le dit : un conteneur ne peut pas
lire une boîte mail.
