# KÔKÔ V3.8 — Contrôle qualité & alertes

## Objectif
Détecter les situations qui nécessitent une attention humaine :
- jalon en retard ;
- jalon bloqué ;
- preuve attendue mais absente ;
- validation client en attente ;
- paiement ou intention de paiement incohérent avec le parcours ;
- réclamation répétée ;
- garantie/SAV en attente trop longtemps.

KÔKÔ produit des **signaux**, pas des verdicts techniques.

## Niveaux
GREEN = normal
AMBER = à surveiller
RED = intervention nécessaire

## Principes
- Un signal n'est pas une preuve de faute.
- Une anomalie de délai n'est pas automatiquement une mauvaise qualité.
- Les décisions techniques importantes nécessitent un professionnel/contrôle humain.
- Toute alerte doit être explicable.
- Les données personnelles doivent être minimisées.
- Les règles et seuils sont configurables et ne constituent pas des seuils légaux.

## API cible
- GET /api/quality/dashboard
- GET /api/quality/interventions/:id
- POST /api/quality/scan
- GET /api/quality/alerts
- POST /api/quality/alerts/:id/acknowledge
- POST /api/quality/alerts/:id/resolve
- GET /api/admin/quality/alerts

## Règles prototype
- Retard léger : AMBER.
- Retard important : RED.
- Jalon sans preuve attendue : AMBER.
- Jalon bloqué : RED.
- SAV dépassant son délai configuré : AMBER/RED selon gravité.
- Réclamations répétées : signal d'analyse, jamais preuve automatique de faute.

## Production
Prévoir moteur de règles versionné, notifications, audit, permissions admin,
calibrage des seuils sur données réelles, mécanisme de contestation et revue humaine.
