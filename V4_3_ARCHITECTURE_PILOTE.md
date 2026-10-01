# KÔKÔ V4.3 — Architecture pilote

## Décision d'architecture

Pour le pilote, KÔKÔ doit rester simple :

Internet
→ HTTPS / reverse proxy
→ API KÔKÔ
→ PostgreSQL
→ stockage privé

Ne pas commencer avec Kubernetes, microservices multiples ou une architecture coûteuse.

## Dimensionnement de départ

Cible pilote :
- 1 VPS ;
- 2 vCPU environ ;
- 2 à 4 Go RAM ;
- SSD ;
- sauvegardes séparées ;
- stockage objet privé pour les fichiers sensibles.

Le dimensionnement réel devra être ajusté selon les tests.

## Pourquoi

KÔKÔ doit d'abord valider :
- nombre de demandes ;
- nombre de professionnels actifs ;
- fréquence des photos ;
- volume des messages ;
- transactions ;
- incidents ;
- coût réel par utilisateur.

L'objectif est de ne pas payer une infrastructure de croissance avant d'avoir une croissance mesurée.

## Séparation

Même avec un seul serveur au pilote :
- API dans son conteneur ;
- PostgreSQL dans son conteneur ;
- réseau Docker interne ;
- Nginx en entrée ;
- données sensibles dans stockage privé.

## Évolution

### Pilote
1 VPS + PostgreSQL + stockage privé.

### Après traction
API séparée de PostgreSQL si nécessaire.

### Croissance
- base managée ;
- stockage objet ;
- cache ;
- workers asynchrones ;
- monitoring avancé ;
- réplication/haute disponibilité selon besoin.

## Règle

On ne scale pas parce que « l'application pourrait devenir grande ».
On scale quand les métriques réelles le justifient.
