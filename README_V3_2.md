# KÔKÔ V3.2 — Signature & preuve électronique

## Objectif
Ajouter un registre technique d’acceptation électronique des contrats, avec version, horodatage, empreinte SHA-256, rôle du signataire et historique.

## Parcours
Devis accepté → contrat → acceptation des documents juridiques → acceptation électronique → empreinte du contrat → preuve → archivage.

## Endpoints
- GET `/api/contracts/:id/signature-status`
- POST `/api/contracts/:id/sign`
- GET `/api/contracts/:id/proof`
- GET `/api/admin/contracts/:id/proof`

## Important — Côte d’Ivoire
Le module ne prétend pas produire une signature électronique qualifiée. La loi ivoirienne prévoit des conditions spécifiques pour les signatures sécurisées et les certificats qualifiés. Une intégration avec un prestataire approprié devra être étudiée avant production. La loi prévoit également des exigences d’archivage garantissant notamment accessibilité, authenticité et intégrité. Sources officielles : ARTCI, loi n°2013-546 et décret n°2014-106.

## Niveau actuel
`ELECTRONIC_ACCEPTANCE_PROOF` — preuve technique d’acceptation.
`qualified_signature_integrated=false`.

## À valider avant production
- qualification juridique exacte de KÔKÔ ;
- prestataire de signature/certification à utiliser ;
- identité et méthode d’authentification du signataire ;
- valeur probatoire et politique de conservation ;
- données personnelles et journaux techniques ;
- modalités de modification, révocation, annulation et archivage.
