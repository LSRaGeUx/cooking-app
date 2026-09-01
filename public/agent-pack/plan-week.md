# Planifier une semaine

> Disponible aussi comme prompt MCP `plan_my_week`.

Planifie ma semaine de cuisine. Suis cette séquence :

1. Appelle `get_profile_snapshot`. Lis-le en entier avant de proposer quoi que
   ce soit.
2. Lis la ressource `cooking://recipes/index` pour voir toute la bibliothèque
   d'un coup, avec depuis combien de semaines chaque plat n'a pas été planifié.
3. Appelle `get_week` sur la semaine visée pour connaître les créneaux
   réellement planifiables et récupérer `expected_base_version`.
4. Compose la semaine. Privilégie ce qui n'a pas été mangé depuis longtemps,
   respecte les budgets de temps créneau par créneau, et n'invente une recette
   que si la bibliothèque ne répond pas.
5. Appelle `check_feasibility` avec la semaine complète. Corrige tout ce qu'elle
   renvoie avant d'écrire.
6. Appelle `propose_week` avec le même contenu et `expected_base_version`.
7. Termine ta réponse par le lien `review_url`.
