# KÔKÔ V4.0 — Préparation à la mise en production

## Objectif
V4.0 ne rajoute pas un nouveau parcours métier. Elle transforme le prototype en **socle exploitable**, avec des contrôles explicites avant lancement.

## Ajouts
- configuration des variables d'environnement ;
- séparation production / test ;
- contrôle de santé de la base ;
- endpoint `/api/health` ;
- endpoint admin `/api/admin/production-readiness` ;
- contrôle des secrets ;
- contrôle de la configuration paiement ;
- contrôle du stockage privé ;
- contrôle HTTPS ;
- checklist de lancement.

## Règle fondamentale
Le résultat `ready_for_public_launch` ne constitue PAS une certification de sécurité ou une validation juridique. Il indique seulement que les contrôles techniques déclarés par ce module sont remplis.

## Avant un vrai lancement
### Technique
- HTTPS obligatoire ;
- secrets hors du code ;
- base de données sauvegardée ;
- test réel de restauration ;
- stockage privé pour les documents/photos/KYC ;
- antivirus et contrôle MIME ;
- limitation de débit ;
- logs et alertes ;
- surveillance disponibilité ;
- procédure de sauvegarde ;
- plan de reprise après incident.

### Paiements
- compte marchand réel ;
- API et clés de production ;
- webhooks signés ;
- idempotence ;
- remboursements réels ;
- rapprochement PSP/comptabilité ;
- gestion des échecs.

### Sécurité
- MFA administrateurs ;
- revue des permissions ;
- rotation des secrets ;
- expiration/révocation des sessions ;
- tests d'intrusion ou revue indépendante ;
- protection contre abus et comptes multiples.

### Juridique
- CGU validées ;
- contrats validés ;
- politique de confidentialité ;
- politique KYC ;
- règles d'annulation/remboursement ;
- rôle juridique exact de KÔKÔ ;
- conformité données personnelles et archivage ;
- validation des documents électroniques/signatures.

### Produit
- pilote réel ;
- 20–50 professionnels ;
- premières transactions réelles ;
- mesure des incidents, litiges, délais et satisfaction ;
- corrections avant ouverture publique.

## Architecture de lancement recommandée
1. Environnement de développement
2. Environnement de test/staging
3. Environnement production
4. Base de données production séparée
5. Stockage privé séparé
6. Prestataire de paiement production
7. Monitoring + sauvegardes
8. Procédure d'incident

## Ce que V4.0 ne fait pas encore
- elle ne crée pas automatiquement un serveur cloud ;
- elle ne branche pas un vrai prestataire de paiement ;
- elle ne remplace pas un audit de sécurité ;
- elle ne garantit pas la conformité juridique ;
- elle ne transforme pas encore le prototype en APK Android publié.

## Étape suivante
Après V4.0, le chantier devient principalement :
**infrastructure réelle → paiement réel → sécurité finale → application mobile → pilote → lancement.**
