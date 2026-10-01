# KÔKÔ — Package complet V4.6

Slogan : **Vérifie. Trouve. Achète. Fais.**

Ce package rassemble le socle applicatif KÔKÔ construit jusqu'à V4.6 : interface, API Node/Express, base SQLite, sécurité/authentification, profils client/pro/admin, demandes, matching, devis, messagerie, notifications, preuves/photos, interventions, paiements/facturation, documents/contrats, signature/preuve électronique, dossiers adaptatifs, jalons, avenants, garanties/SAV, contrôle qualité, remboursements/réconciliation, anti-fraude/confiance, KYC et préparation pilote.

## Démarrage local

```bash
npm install
npm start
```

Puis ouvrir `http://localhost:10000` (ou la valeur de `PORT`).

## Déploiement Render

- Type : **Web Service**
- Build Command : `npm install`
- Start Command : `npm start`
- Root Directory : vide
- Plan : Free pour le test
- Aucune variable secrète n'est requise pour le prototype de test. `PORT` est fourni par Render.

## Important

La version actuelle utilise SQLite pour le pilote/prototype. Pour une production réelle, prévoir une base PostgreSQL managée, des sauvegardes, des secrets gérés côté hébergeur, une revue juridique et une validation sécurité.

Le fichier `index.html` est à la racine et `server.js` le sert directement afin de correspondre au déploiement Render testé.
