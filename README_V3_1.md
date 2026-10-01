# KÔKÔ V3.1 — Parcours juridique ivoirien

## Objectif
Transformer le socle juridique V3.0 en parcours applicatif : lecture des documents, acceptation versionnée, preuve d'acceptation et garde-fou avant création d'un contrat.

## Fonctionnalités
- `/api/legal/documents` : liste des documents juridiques actifs.
- `/api/legal/documents/:slug` : lecture d'une version.
- `/api/legal/accept` : acceptation authentifiée d'une version publiée.
- `/api/legal/acceptances/me` : historique des acceptations de l'utilisateur.
- `/api/legal/check` : contrôle des documents nécessaires au parcours contractuel.
- `/api/admin/legal/publish/:id` : publication par un administrateur.
- `/api/admin/legal/events` : journal des événements juridiques.
- Interface visible « Documents juridiques ».
- Blocage de la création d'un contrat si CGU, confidentialité, paiement et litiges ne sont pas acceptés dans leur version publiée.

## Côte d'Ivoire
- Pays : Côte d'Ivoire
- Devise : XOF / FCFA
- Langue : français
- Références de conception : loi n°2013-546 sur les transactions électroniques, loi n°2013-450 sur les données personnelles, décret n°2014-106 sur l'écrit et la signature électronique, décret n°2016-851 sur l'archivage électronique.

## Important
Les documents V3.0 initialisés en statut `LEGAL_REVIEW_REQUIRED` ne peuvent pas être acceptés comme versions contractuelles définitives. Un administrateur ne doit publier qu'après validation juridique.

La V3.1 ne fabrique pas une signature électronique qualifiée. Pour une signature électronique ayant une valeur probatoire renforcée, KÔKÔ devra intégrer un prestataire/solution conforme au cadre applicable et faire valider le dispositif juridiquement.

## Production
Avant lancement :
1. faire valider les documents par un juriste/avocat en Côte d'Ivoire ;
2. arrêter le rôle juridique exact de KÔKÔ ;
3. définir les durées de conservation et les traitements de données ;
4. mettre en place un stockage sécurisé des preuves et documents ;
5. intégrer un vrai prestataire de signature électronique si nécessaire ;
6. vérifier les règles applicables au paiement et à la consommation ;
7. sécuriser les comptes administrateurs et le journal d'audit.
