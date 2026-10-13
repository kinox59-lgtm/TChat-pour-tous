# Tchat Pour Tous

Tchat en direct façon tchats d'autrefois, sans inscription, gratuit, pour tout le monde : hétéro, homo, bi, trans…

## Lancer chez toi (test)
1. Installe Node.js 18+ (nodejs.org)
2. Dans ce dossier : `npm install` puis `npm start`
3. Ouvre http://localhost:3000 dans deux onglets pour tester.

## Mettre en ligne gratuitement
Il faut un hébergeur qui accepte Node.js + WebSocket (Render, Railway, Fly.io, Koyeb… les offres gratuites changent, vérifie leurs conditions).
- Mets ce dossier sur GitHub, crée un « Web Service » sur l'hébergeur
- Build : `npm install` — Start : `npm start`
- L'hébergeur te donne une adresse publique : c'est ton site.

Sur certaines offres gratuites, le serveur s'endort après un moment d'inactivité : la première visite est alors lente.
Les messages ne sont gardés qu'en mémoire (40 derniers par salon) et disparaissent au redémarrage.

## Signalement et bannissements
Bouton ⚠ à côté de chaque pseudo dans la liste des connectés. Un signalement sanctionne immédiatement :
- 1re sanction : 15 minutes, 2e : 30 minutes, 3e : 1 jour, 4e et suivantes : à vie (cette dernière règle est un choix par défaut, modifiable dans `DURATIONS` de server.js)
- 3 personnes différentes qui signalent la même personne dans une fenêtre de 2 minutes : bannissement à vie
- Le bannissement vise l'adresse IP (stockée uniquement sous forme d'empreinte). Définis la variable d'environnement `SALT` (texte secret au choix) sur ton hébergeur.
- Les sanctions sont écrites dans `bans.json`. Sur beaucoup d'hébergeurs gratuits, le disque est effacé à chaque redémarrage : les bannissements le sont aussi.

Contenus pédocriminels : signale-les aussi à la plateforme officielle https://www.internet-signalement.gouv.fr (Pharos) ou au 17.

## Messages privés
Clique sur un pseudo (ou sur ✉) dans la liste des connectés pour ouvrir une conversation privée à deux. Chaque conversation a son onglet au-dessus des messages, avec un compteur de messages non lus. On peut écrire en privé à toute personne connectée, quel que soit son salon. Les messages privés ne passent que par le serveur, ne sont pas enregistrés, et le bouton ⚠ Signaler est aussi disponible dans chaque conversation privée.

## Photo de profil
Facultative, choisie à l'entrée ou plus tard avec le bouton « 📷 Ma photo » (et « ✕ photo » pour la retirer). La photo est recadrée en carré et réduite à 96×96 dans le navigateur, puis envoyée au serveur qui vérifie que c'est bien un petit JPEG. Elle est gardée en mémoire seulement : elle disparaît quand la personne quitte le tchat ou est bannie. Sans photo, un rond de couleur avec l'initiale est affiché.
Attention : aucun contrôle automatique du contenu des photos n'est fait. La modération repose sur le bouton ⚠ de signalement.

## Nouveau design et barre des connectés
Interface moderne : barre latérale avec les salons, puis la liste de TOUS les connectés (avec photo, âge, ville, salon), recherche par pseudo et pastille de messages non lus. Un clic sur une personne ouvre la discussion privée. Sur téléphone, la barre s'ouvre avec le bouton ☰.

## Filles / garçons et région
La liste des connectés est classée en sections « ♀ Filles », « ♂ Garçons » et « Autres », avec une pastille de couleur autour de la photo (rose, bleu, violet) et des filtres Tous / Filles / Garçons. Chaque personne affiche son âge, sa ville et sa région (choisie à l'entrée), puis son salon.

## Je cherche / orientation
À l'entrée, chaque personne peut (facultatif) indiquer son sexe (homme, femme, transgenre, autre), ce qu'elle cherche (un homme, une femme, les deux, une personne transgenre, peu importe) et son orientation (hétéro, homo, bi, autre). Ces infos sont visibles dans la liste des connectés et le filtre « 💘 Pour moi » ne montre que les personnes correspondant à ce que tu cherches. Ce sont des données sensibles : elles restent en mémoire du serveur, ne sont jamais enregistrées, et sont facultatives.

## Photos et vidéos en privé
Bouton 📎 dans les conversations privées uniquement (pas dans les salons). Photos JPEG (réduites à 1024 px) et vidéos MP4/WebM de 3 Mo maximum.
Protections intégrées : la personne doit d'abord t'avoir écrit un message avant que tu puisses lui envoyer un média ; les médias reçus sont floutés tant qu'on n'a pas appuyé ; 5 envois par minute maximum ; le serveur vérifie le vrai format du fichier ; les fichiers restent en mémoire 30 minutes puis sont effacés ; un bannissement efface tous les médias de la personne ; bouton ⚠ sous chaque média reçu.
Pour désactiver complètement les photos/vidéos : variable d'environnement `MEDIA=off`.
Important : aucun contrôle automatique du contenu n'est possible. En cas de contenu impliquant des mineurs, ne le conserve pas, et signale-le tout de suite sur https://www.internet-signalement.gouv.fr (Pharos).

## Avis et idées
- Un salon « Avis & idées » où les visiteurs discutent des améliorations (message de bienvenue de l'« Équipe » ; les pseudos Équipe, Admin, Modérateur… sont réservés).
- Un bouton « 💡 Donner mon avis » : le visiteur choisit Idée / Problème / Compliment et écrit jusqu'à 500 caractères (3 avis max toutes les 10 minutes).
- Pour lire les avis : définis la variable d'environnement `ADMIN_KEY` (un long mot de passe de ton choix) puis ouvre `https://TON-SITE/avis?key=TON_ADMIN_KEY`. Sans `ADMIN_KEY`, la page n'existe pas.
- Les avis sont écrits dans `avis.json` (effacé au redémarrage sur beaucoup d'hébergeurs gratuits : relève-les régulièrement).

## Photos visibles et régions
Les photos de profil s'affichent en grand dans la liste des connectés et à côté des messages ; un clic sur une photo ouvre la fiche de la personne (photo agrandie, âge, ville, région, ce qu'elle cherche) avec un bouton pour lui écrire. La liste des régions contient toutes les régions de France (13 métropolitaines + Guadeloupe, Martinique, Guyane, La Réunion, Mayotte) ainsi que les autres territoires d'outre-mer, et un filtre « Toutes les régions » permet de ne voir que les connectés d'une région.

## Départements
À l'entrée, on choisit son département (numéro + nom, par exemple « 35 · Ille-et-Vilaine »), classé par région : 96 départements métropolitains (dont 2A et 2B), les départements d'outre-mer et les autres territoires (971, 972, 973, 974, 975, 976, 977, 978, 986, 987, 988). La région est déduite automatiquement. Le profil affiche par exemple « Rennes · Ille-et-Vilaine (35) · Bretagne ».

## Entrée facile, accueil et sécurité
- Âge de 18 à 99 ans, avec case « J'ai 18 ans ou plus » obligatoire (vérifié aussi par le serveur).
- Bouton 🎲 pour un pseudo au hasard, et bouton « ⚡ Reprendre en tant que… » pour les personnes déjà venues (leur profil est mémorisé dans leur propre navigateur, avec un bouton « Oublier »).
- Petite fenêtre de bienvenue en 4 points à la première visite.
- Bouton « 🛡️ Conseils de sécurité » dans la barre (rencontres : lieu public, prévenir un proche, ne jamais envoyer d'argent…).
- Installable sur l'écran d'accueil du téléphone (manifeste et icônes inclus) : sur iPhone avec Safari > Partager > Sur l'écran d'accueil ; sur Android avec le menu du navigateur > Installer l'application. Ça marche en HTTPS, donc chez l'hébergeur.

## Filtre d'âge et départements dans l'ordre
- Dans la barre, deux cases « Âge de … à … » filtrent la liste des connectés (par exemple 25 à 40). Les conversations hors ligne restent visibles.
- La liste des départements est classée par numéro : 01 à 19, puis 2A et 2B, puis 21 à 95, puis l'outre-mer (971 à 988) et « Autre pays ».

## Mise en ligne en un clic sur Render
1. Mets le contenu de ce dossier (avec `render.yaml`) à la racine d'un dépôt GitHub.
2. Sur render.com : New > Blueprint > choisis ton dépôt > Apply.
3. Render te demande une valeur pour `ADMIN_KEY` : choisis un mot de passe de lettres et chiffres (il sert à lire les avis sur `/avis?key=...`). `SALT` est généré automatiquement.
4. Attends la fin du déploiement : l'adresse du site apparaît en haut de la page du service.
Rappel : sur l'offre gratuite, le site s'endort après 15 minutes sans visite et les fichiers (bannissements, avis) sont effacés à chaque redémarrage.
