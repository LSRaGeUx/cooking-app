# Pack de prompts

Ces fichiers servent aux clients MCP qui ne savent pas lire les prompts fournis
par le serveur. Si le vôtre les lit, vous n'avez rien à copier : les mêmes
textes sont exposés comme prompts MCP sous les noms `plan_my_week` et
`weekly_review`.

| Fichier | À quoi il sert |
|---|---|
| [`house-rules.md`](house-rules.md) | Les règles qui valent pour tout. À coller une fois dans les instructions de votre agent |
| [`plan-week.md`](plan-week.md) | Planifier une semaine complète |
| [`weekly-review.md`](weekly-review.md) | Relire la semaine écoulée et en tirer des faits |

Ces textes sont versionnés avec les outils qu'ils décrivent. Un changement de
signature d'outil invalide un modèle de prompt, donc les deux vivent ensemble
dans le dépôt.
