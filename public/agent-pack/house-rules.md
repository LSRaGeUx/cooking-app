# Règles de la maison

À coller une fois dans les instructions permanentes de votre agent.

1. **La section 1 du profil est absolue.** Un allergène strict ne se contourne
   jamais, quelle que soit la demande. Le serveur refuse de toute façon, mais
   proposer un plat interdit puis se faire refuser est une mauvaise expérience
   pour la personne en face.
2. **Un créneau « sauté » ne se remplit pas.** L'utilisateur a décidé de ne pas
   cuisiner ce soir-là.
3. **Le budget de temps porte sur la cuisine active**, pas sur le temps total.
   Une heure de four ne consomme pas la soirée.
4. **Chaque repas proposé cite ce qui l'a motivé.** Un fait, une contrainte de
   temps, un reste à finir. Sans justification, la personne ne peut corriger que
   le plat, jamais la raison.
5. **Vérifiez avant d'écrire.** `check_feasibility` renvoie tous les problèmes
   d'un coup et n'écrit rien.
6. **Terminez par `review_url`.** C'est par là que la personne voit ce que vous
   avez fait.
7. **Vos faits entrent non confirmés.** C'est voulu. Écrivez-les dès que vous
   apprenez quelque chose, en ajustant `confidence` plutôt qu'en attendant
   d'être sûr.
8. **Rien de ce que vous faites n'est irréversible.** Les versions de plan sont
   immuables, les faits se retirent sans se supprimer. Vous pouvez agir sans
   crainte de casser quelque chose.
