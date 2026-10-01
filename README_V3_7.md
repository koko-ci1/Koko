# KÔKÔ V3.7 — Garanties & SAV

## Objectif
Étendre KÔKÔ après la fin de la prestation afin de gérer les garanties contractuelles,
les demandes de service après-vente (SAV), les preuves et la clôture.

## Parcours
Prestation terminée → garantie enregistrée → problème signalé → vérification de couverture
→ réponse du professionnel → intervention SAV → preuves → résolution → validation client → clôture.

## Données principales
- warranties: prestation/contrat, titre, couverture, exclusions, durée, dates, statut.
- warranty_claims: garantie, demandeur, problème, description, statut, dates, résolution.
- warranty_evidence: réclamations, type de preuve, référence, commentaire.
- warranty_events: historique immuable des changements importants.

## Statuts garantie
ACTIVE, EXPIRED, SUSPENDED, CANCELLED.

## Statuts SAV
OPEN, UNDER_REVIEW, ACCEPTED, REJECTED, SCHEDULED, IN_PROGRESS,
RESOLVED, CLIENT_CONFIRMED, CLOSED.

## Principes
- KÔKÔ ne crée pas une garantie légale qui n'existe pas.
- La couverture affichée provient du contrat/devis/avenant applicable.
- Une alerte ou une réclamation n'est pas une preuve de faute.
- Les décisions techniques restent du ressort du professionnel compétent et,
  lorsque nécessaire, d'un contrôle humain.
- Les données personnelles sont minimisées et protégées.
- Les conditions définitives doivent être validées juridiquement avant production.

## API cible
- POST /api/warranties
- GET /api/warranties
- GET /api/warranties/:id
- POST /api/warranties/:id/claims
- GET /api/warranties/:id/claims
- POST /api/warranty-claims/:id/evidence
- POST /api/warranty-claims/:id/status
- POST /api/warranty-claims/:id/resolve
- POST /api/warranty-claims/:id/confirm
- GET /api/warranty-claims/:id/history
- GET /api/admin/warranty-claims

## Production
Prévoir stockage privé des pièces/preuves, contrôle d'accès, journalisation,
notifications, politique de conservation, gestion des remboursements éventuels,
et validation juridique des clauses de garantie/SAV.
