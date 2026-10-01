# KÔKÔ V4.3 — Options d'infrastructure

## Option A — DigitalOcean

Les tarifs officiels actuels indiquent des Basic Droplets à partir de 4 $/mois, avec par exemple 1 Go RAM / 1 vCPU / 25 Go SSD à 6 $/mois. Les offres 2 vCPU / 4 Go / 80 Go sont affichées à 24 $/mois. citeturn0search0turn0search5

Avantages :
- interface simple ;
- Docker facile à exploiter ;
- documentation abondante ;
- adapté à un premier pilote.

## Option B — Hetzner

Les tarifs officiels 2026 montrent notamment des Cloud Servers d'entrée de gamme autour de 5–7 $/mois selon la gamme/configuration et la localisation. Les prix dépendent du modèle et de la région. citeturn0search3

Avantages :
- coût souvent compétitif ;
- bonnes ressources pour le prix.

## Choix pratique pour KÔKÔ

Le choix final doit tenir compte de :
- moyen de paiement disponible pour Grandium/KÔKÔ ;
- localisation disponible ;
- facilité d'administration ;
- sauvegardes ;
- support ;
- exigences de protection des données ;
- coût total du stockage et des sauvegardes.

Ne pas choisir uniquement sur le prix affiché du VPS.

## Recommandation d'architecture

Pour le pilote :
- 1 VPS ;
- 2 vCPU ;
- 2–4 Go RAM ;
- 40–80 Go SSD ;
- stockage privé séparé pour fichiers ;
- sauvegarde quotidienne ;
- monitoring.

Puis augmenter progressivement.
