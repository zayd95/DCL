# DEPOTEK — Backend Supabase

Nouveau backend de DEPOTEK : **Postgres + fonctions métier + assistant IA + briefing du matin**.
Tout tient dans le **plan gratuit** Supabase, plus la clé Gemini gratuite de Google AI Studio.

## Pourquoi ce backend

| Besoin | Avant (Firebase) | Maintenant (Supabase) |
|---|---|---|
| Stock fiable | Compteurs mis à jour côté client, double écriture ancien/nouveau schéma | **Grand livre immuable** + soldes par trigger, `CHECK quantité ≥ 0` : impossible de sortir plus que le stock, même à deux en même temps |
| FEFO | Approximatif (par document) | Par **lot** et date d'expiration ; les lots expirés sont **bloqués** à la vente |
| Ventes & créances | Absent | Factures numérotées (`FAC-2026-00001`), paiements Wave / OM / espèces, encours, retards, **limite de crédit** |
| Marge | Absent | Coût de revient figé par lot (taux de change à l'import) → marge par vente, produit, client |
| Location de froid | Absent | Contrats, palettes × jours, **facturation mensuelle automatique** |
| IA | Clé Gemini exposée dans le navigateur, assistant vocal non branché | Clé **côté serveur**, assistant branché sur les vraies données, **confirmation obligatoire** avant toute écriture |
| Tâches planifiées | Serveur Express à héberger soi-même | `pg_cron` inclus et gratuit |
| Sécurité | Règles Firestore | RLS Postgres par rôle : magasinier / manager / cfo / admin |

## Contenu

```
supabase/
├── migrations/
│   ├── 20261115000001_core_schema.sql     tables, grand livre, factures, stockage tiers
│   ├── 20261115000002_business_logic.sql fonctions métier + vues
│   └── 20261115000003_security.sql        RLS, droits, profils
├── functions/
│   ├── assistant/        agent Gemini (lecture directe, écriture après confirmation)
│   ├── daily-briefing/   briefing de 7 h → Telegram + alerte dans l'app
│   └── _shared/          formatage FCFA / briefing
├── cron.sql              planification (briefing 7 h, alertes, facturation du 1er)
└── tests/                test de bout en bout du métier + tests des fonctions
```

## Installation (≈ 20 min)

1. Créer un compte sur [supabase.com](https://supabase.com), puis un projet **gratuit** « depotek »
   (région la plus proche : Europe West / Frankfurt).
2. Installer la CLI et relier le projet :
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <PROJECT_REF>
   ```
3. Créer la base :
   ```bash
   supabase db push
   ```
4. Secrets des fonctions : copier `supabase/functions/.env.example` en `supabase/functions/.env`, le remplir, puis
   ```bash
   supabase secrets set --env-file supabase/functions/.env
   supabase functions deploy assistant
   supabase functions deploy daily-briefing
   ```
5. Ouvrir **SQL Editor**, coller `supabase/cron.sql` (en remplaçant `<PROJECT_REF>` et `<CRON_SECRET>`) et exécuter.
6. Se connecter une première fois depuis l'app : **le premier compte devient admin**.
   Les suivants sont `magasinier` ; changer leur rôle dans la table `profiles`.
7. Telegram (optionnel) : créer un bot avec @BotFather, envoyer `/start` au bot, récupérer son
   chat id (par ex. via @userinfobot) et le mettre dans `profiles.telegram_chat_id`.

Tester le briefing sans rien envoyer :
```bash
curl -H "x-cron-secret: <CRON_SECRET>" "https://<PROJECT_REF>.supabase.co/functions/v1/daily-briefing?dry=1"
```

## Utiliser l'assistant

```ts
const { data } = await supabase.functions.invoke("assistant", {
  body: { messages: [{ role: "user", text: "Qui me doit de l'argent et depuis combien de temps ?" }] },
});
// data.reply → texte ; data.pending_action → { id, summary } si une écriture attend confirmation

await supabase.functions.invoke("assistant", { body: { action_id: id, decision: "confirm" } }); // ou "cancel"
```

Exemples : « Combien de cartons de foie il reste ? », « Quels lots expirent ce mois-ci ? »,
« Vends 20 cartons de cuisses à Moussa à 15 000 », « Moussa a payé 500 000 par Wave »,
« Ventes et marge de la semaine », « Qu'est-ce que je dois commander ? ».

## Fonctions métier (appelables depuis l'app : `supabase.rpc(...)`)

| Fonction | Rôles | Rôle métier |
|---|---|---|
| `receive_lot` | magasinier, manager | Réception d'un lot (refuse les lots expirés ; taux de change figé) |
| `dispatch_fefo` | magasinier, manager | Sortie FEFO + facture + contrôle de la limite de crédit |
| `transfer_stock` | magasinier, manager | Transfert inter-dépôts |
| `adjust_stock` | manager | Inventaire / perte, avec motif obligatoire |
| `create_client` | manager, cfo | Nouveau client |
| `record_payment` / `record_client_payment` | manager, cfo | Encaissement (imputation à l'échéance la plus proche) |
| `storage_pallets` / `bill_storage` | magasinier / manager, cfo | Location de froid |
| `sales_summary`, `daily_briefing` | manager, cfo | Ventes, marge, synthèse |

Vues : `v_stock_lots`, `v_stock_products` (couverture en jours + besoin de réappro), `v_receivables`, `v_client_balances`.

## Tests

```bash
# Postgres 15+ local
PGHOST=localhost PGUSER=postgres ./supabase/tests/run.sh          # base + métier
cd supabase/functions && deno test --allow-read --allow-env tests/ # fonctions
```

Le test métier joue un scénario complet (réceptions, ventes FEFO, crédit, transfert, perte,
paiements, location de froid, alertes, briefing) en vérifiant les droits de chaque rôle.

## Limites du plan gratuit à connaître

- Base 500 Mo : largement suffisant pour des années de mouvements.
- Un projet gratuit **inactif pendant 7 jours est mis en pause** ; un usage quotidien de l'app l'évite.
- Pas de sauvegardes automatiques en gratuit : prévoir un export régulier (`supabase db dump`).
