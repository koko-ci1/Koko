# KÔKÔ V3.6 — Avenants & modifications de chantier

## Objectif
Permettre de gérer les travaux supplémentaires, changements de périmètre et ajustements de montant sans modifier silencieusement le contrat initial.

## Parcours
Proposition → motif → modification de périmètre/montant → acceptation client → acceptation professionnel → application → nouvelle version du contrat → mise à jour du dossier → historique.

## Règles
- Un avenant est séparé du contrat initial.
- Le contrat n'est modifié qu'après acceptation des deux parties.
- La version du contrat est incrémentée à l'application.
- Le montant total est recalculé explicitement.
- Les événements sont historisés.
- Le dossier de prestation conserve la trace de l'avenant.
- Un contrat terminé ou annulé ne reçoit plus d'avenant.
- Le refus laisse la proposition et son historique accessibles.

## Routes principales
- POST `/api/contracts/:contractId/amendments`
- GET `/api/contracts/:contractId/amendments`
- GET `/api/amendments/:id`
- POST `/api/amendments/:id/accept`
- POST `/api/amendments/:id/reject`
- GET `/api/dossiers/:id/amendments`

## Important
Cette implémentation est un mécanisme produit et de traçabilité. Elle ne constitue pas une signature électronique qualifiée et doit être soumise à validation juridique avant production.
