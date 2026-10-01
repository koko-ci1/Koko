# KÔKÔ V3.3 — Documents contractuels professionnels

## Objectif
Transformer le devis accepté en un document contractuel structuré, versionné et traçable.

## Ajouts
- Génération d'un contrat HTML imprimable depuis le contrat KÔKÔ.
- Identification client/professionnel.
- Objet, montant XOF, calendrier, paiement, annulation et garantie.
- Empreinte SHA-256 de la version contractuelle.
- Historique des générations de documents.
- Consultation du document par les parties autorisées.
- Conservation séparée du document et de la preuve d'acceptation.

## Routes
- POST `/api/contracts/:id/document/generate`
- GET `/api/contracts/:id/document`
- GET `/api/contracts/:id/documents`

## Côte d'Ivoire
Le socle est paramétré pour la Côte d'Ivoire et le XOF. La loi ivoirienne relative aux transactions électroniques encadre l'écrit, la signature et l'archivage électroniques. Les conditions précises d'une signature électronique sécurisée/qualifiée doivent être respectées lorsqu'elles sont nécessaires. La protection des données personnelles relève notamment de la loi n°2013-450.

## Important
Ce module est un socle technique et ne constitue pas une validation juridique. Avant production, faire valider les contrats, CGU, clauses BTP, politique de données, conservation, preuve et dispositif de signature par un professionnel du droit compétent en Côte d'Ivoire.
