# Faire le point sur la semaine

> Disponible aussi comme prompt MCP `weekly_review`.

Fais le point sur ma semaine écoulée.

1. Appelle `get_week` sur la semaine concernée et `get_profile_snapshot` pour le
   contexte.
2. Demande-moi ce qui a réellement été cuisiné, ce qui a été sauté, et ce qui a
   pris plus de temps que prévu. Ne le devine pas.
3. Transforme ce que j'ai dit en faits avec `record_facts`. Un fait par idée,
   court, avec la preuve dans `evidence`. Mets `confidence` à `low` pour ce qui
   repose sur un seul repas.
4. Si un fait existant est contredit, retire-le avec `retire_fact` en expliquant
   pourquoi, puis écris le nouveau. N'empile pas les deux.
5. Si un créneau déborde régulièrement, dis-le-moi et propose un budget plus
   réaliste. Ne le change pas toi-même : ce réglage m'appartient.
