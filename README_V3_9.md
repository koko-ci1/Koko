# KÔKÔ V3.9 — Annulation, remboursement & réconciliation

## Objectif
Ajouter une couche financière traçable autour de l'annulation et du remboursement :
- demande d'annulation ;
- décision admin ;
- demande de remboursement total ou partiel ;
- historique des événements ;
- simulation de remboursement en environnement de test ;
- réconciliation entre montant attendu et montant observé.

## Parcours
Contrat / paiement → demande d'annulation → décision → demande de remboursement → validation → traitement PSP → confirmation → réconciliation.

## Endpoints principaux
- `POST /api/cancellations`
- `GET /api/cancellations`
- `POST /api/admin/cancellations/:id/decision`
- `POST /api/refunds`
- `GET /api/refunds`
- `GET /api/refunds/:id/events`
- `POST /api/admin/refunds/:id/decision`
- `POST /api/refunds/:id/simulate-success`
- `POST /api/admin/reconciliation`
- `GET /api/admin/reconciliation`
- `POST /api/admin/reconciliation/:id/resolve`

## Règles importantes
1. Aucun argent réel n'est déplacé par ce module.
2. La simulation est interdite en production.
3. Un remboursement partiel doit être justifié.
4. Les règles d'annulation/remboursement doivent venir du contrat/CGU validés.
5. Une demande de remboursement ou un litige ne prouve pas automatiquement une faute du professionnel.
6. Toute intégration PSP réelle doit utiliser des webhooks authentifiés, l'idempotence, des références fournisseur et une réconciliation.

## Production à prévoir
- intégration du PSP réellement choisi ;
- signature des webhooks et vérification anti-rejeu ;
- idempotence ;
- gestion des remboursements partiels ;
- rapprochement automatique PSP/comptabilité ;
- gestion des échecs et exceptions ;
- journal d'audit immuable ;
- droits d'accès stricts ;
- règles fiscales et contractuelles validées en Côte d'Ivoire ;
- procédures de contestation et d'appel.

## Positionnement
V3.9 complète la chaîne financière de KÔKÔ, mais ne rend pas encore KÔKÔ prêt à encaisser/rembourser de l'argent réel sans intégration et validation de production.
