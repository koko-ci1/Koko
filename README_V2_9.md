# KÔKÔ V2.9 — Contrats & engagement

Base : V2.8 KYC & vérification professionnelle.

## Fonctionnalités
- Création d'un contrat à partir d'un devis.
- Périmètre détaillé de la prestation.
- Montant en XOF.
- Dates prévues.
- Conditions d'annulation, garantie et paiement.
- Acceptation séparée du client et du professionnel.
- Contrat ACTIVE seulement lorsque les deux parties ont accepté.
- Journal des événements et des modifications.
- Annulation tracée.
- Validation de fin par le client.
- Consultation administrative.

## API
- POST `/api/contracts/from-quote/:quoteId`
- GET `/api/contracts`
- GET `/api/contracts/:id`
- PUT `/api/contracts/:id`
- POST `/api/contracts/:id/accept`
- POST `/api/contracts/:id/cancel`
- POST `/api/contracts/:id/complete`
- GET `/api/admin/contracts`

## Important
Ce module constitue une couche de preuve et d'accord dans le prototype. Il ne remplace pas une analyse juridique ni un contrat conforme aux obligations locales. Avant production : version juridique des CGU/contrats, signature électronique si nécessaire, archivage probant, horodatage, intégrité/hash des documents, gestion des avenants, règles de remboursement/annulation et conformité fiscale.
