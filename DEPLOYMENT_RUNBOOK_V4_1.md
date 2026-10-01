# KÔKÔ V4.1 — Runbook de déploiement

## Objectif

V4.1 prépare un environnement de production reproductible autour de :

- API KÔKÔ ;
- PostgreSQL ;
- stockage privé ;
- reverse proxy HTTPS ;
- variables d'environnement ;
- sauvegardes.

## Architecture

Internet
→ HTTPS / Nginx
→ KÔKÔ API
→ PostgreSQL

Les photos, documents financiers et documents KYC doivent aller dans un stockage privé, jamais dans un dossier public.

## Déploiement

### 1. Préparer le serveur

Choisir un serveur cloud/VPS adapté au pilote et configurer :

- système à jour ;
- pare-feu ;
- Docker ;
- DNS ;
- HTTPS ;
- accès SSH sécurisé.

### 2. Configurer les secrets

Copier `.env.production.example` vers `.env.production` et remplacer toutes les valeurs `CHANGE_ME`.

Ne jamais envoyer `.env.production` dans Git ou dans un ZIP public.

### 3. Configurer PostgreSQL

Utiliser un mot de passe fort et unique.

En production réelle, le mot de passe PostgreSQL ne doit pas rester écrit directement dans `docker-compose.production.yml`. Utiliser un mécanisme de secrets ou un service managé.

### 4. Lancer

```bash
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d
```

### 5. Vérifier

```bash
docker compose -f docker-compose.production.yml ps
curl https://app.example.ci/api/health
```

Le endpoint `/api/health` doit répondre sans exposer de secret.

### 6. Sauvegardes

Mettre en place une sauvegarde PostgreSQL automatisée et surtout tester régulièrement la restauration.

Une sauvegarde jamais restaurée/testée n'est pas considérée comme suffisante.

### 7. Stockage privé

Les éléments sensibles doivent être privés :

- KYC ;
- justificatifs ;
- photos de chantier ;
- preuves ;
- documents financiers.

L'application doit fournir des accès authentifiés ou des URLs temporaires signées.

## Sécurité avant ouverture publique

- MFA administrateurs ;
- SSH par clé ;
- pare-feu ;
- HTTPS ;
- secrets hors dépôt ;
- limitation de débit ;
- logs ;
- alertes ;
- sauvegardes ;
- test de restauration ;
- antivirus pour fichiers ;
- contrôle MIME ;
- permissions minimales ;
- revue indépendante de sécurité.

## Paiements

Ne brancher le vrai PSP qu'après :

1. compte marchand validé ;
2. clés de production ;
3. webhook authentifié ;
4. idempotence ;
5. gestion des remboursements ;
6. rapprochement ;
7. tests de bout en bout.

## Attention

Les fichiers V4.1 sont un **gabarit de déploiement**, pas une mise en production automatique.

Avant un vrai lancement, les valeurs d'environnement, le serveur, le domaine, le stockage et le prestataire de paiement doivent être réellement configurés et testés.
