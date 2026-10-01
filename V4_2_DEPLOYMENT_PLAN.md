# KÔKÔ V4.2 — Plan de déploiement réel

## But
Passer du dossier de configuration à une procédure contrôlée de mise en ligne.

## Ordre recommandé

### Étape 1 — Infrastructure
- Choisir un VPS/cloud.
- Installer Docker.
- Configurer le pare-feu.
- Créer un utilisateur de déploiement non-root.
- Configurer SSH par clé.

### Étape 2 — Domaine
- Choisir le sous-domaine de production, par exemple `app.votredomaine.ci`.
- Créer un enregistrement DNS A/AAAA vers le serveur.
- Vérifier la résolution DNS avant d'activer HTTPS.

### Étape 3 — Secrets
Créer `.env.production` uniquement sur le serveur.
Ne jamais mettre les vrais secrets dans Git.

Secrets minimum :
- JWT_SECRET
- SESSION_SECRET
- DATABASE_URL
- PAYMENT_API_KEY
- PAYMENT_WEBHOOK_SECRET
- STORAGE credentials

### Étape 4 — Base
- Créer PostgreSQL.
- Appliquer les migrations du projet.
- Créer un compte DB à privilèges minimaux.
- Tester une lecture et une écriture.
- Tester une sauvegarde/restauration.

### Étape 5 — API
- Construire l'image.
- Démarrer le conteneur.
- Vérifier `/api/health`.
- Vérifier les logs.
- Vérifier que les erreurs ne révèlent aucun secret.

### Étape 6 — HTTPS
- Configurer le certificat TLS.
- Rediriger HTTP vers HTTPS.
- Vérifier les cookies Secure/SameSite lorsque l'authentification web est utilisée.

### Étape 7 — Stockage
Les fichiers KYC, justificatifs, photos et documents financiers doivent rester privés.
Utiliser des URLs temporaires signées ou un téléchargement authentifié.

### Étape 8 — Tests de fumée
Tester :
1. création de compte ;
2. connexion ;
3. création d'une demande ;
4. matching ;
5. devis ;
6. contrat ;
7. paiement simulé en staging ;
8. preuve/photo ;
9. litige ;
10. remboursement simulé ;
11. notifications.

### Étape 9 — Go/No-Go
Ne pas ouvrir au public tant que :
- les sauvegardes ne sont pas testées ;
- les accès admin ne sont pas protégés par MFA ;
- le paiement réel n'est pas validé ;
- les règles juridiques ne sont pas validées ;
- les documents sensibles ne sont pas protégés ;
- les tests critiques ne sont pas passés.

## Important
V4.2 prépare le déploiement. Elle ne crée pas automatiquement un compte cloud, ne modifie pas le DNS et n'active pas un paiement réel.
