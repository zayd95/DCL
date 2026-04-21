# 🚀 DEPOTEK

### Smart Warehouse & Container Flow System (Africa-first)

---

# 🧭 1. Identité & Produit

**Nom :** DEPOTEK *(ex Dakar Cold-Link)*
**Positionnement :** Plateforme de gestion logistique intelligente pour importateurs, hubs frigorifiques et distributeurs.

## 📱 Frontend

* **Framework :** React Native / Expo (iOS & Android)
* **Architecture :** Mobile-first, "Field-Ready"
* **Navigation unifiée :**

  * 📦 INVENTAIRE
  * 📊 CENTRE
  * 🚢 ENTRÉES
  * 🏢 DÉPÔTS

## 🎨 Design System

* Couleurs : Bleu profond `#1a237e` + blanc pur
* UI compacte (padding 14px)
* Cartes dynamiques (data > décoration)
* UX orientée action (pas de dashboards passifs)

---

# 🏗️ 2. Architecture Firebase

Base conçue pour : **traçabilité + performance + scalabilité**

## 🔐 `/users`

Gestion des rôles et permissions

```json
{
  "role": "admin | manager | depot"
}
```

👉 Contrôle :

* accès aux données financières
* permissions d'écriture

---

## 📦 `/stock` (Pivot Central)

**Source de vérité de l'inventaire**

```json
{
  "sku": "DKR-BFF-01",
  "lot": "LOT-BFF-01",

  "stockType": "unitized | bulk",

  "units": 1425,
  "unitWeight": 20,
  "totalWeightKg": 28500,

  "costPrice": 80,
  "costPer": "unit | kg",

  "depotId": "SODIDA",
  "containerId": "MTDU1234567",

  "expiration": "2026-09-21",
  "status": "available"
}
```

---

## 🔄 `/movements` (Audit Trail)

Historique immuable de chaque action

```json
{
  "type": "entry | exit | transfer | adjustment",

  "sku": "DKR-BFF-01",
  "quantity": 1425,
  "weightKg": 28500,

  "fromDepot": null,
  "toDepot": "SODIDA",

  "userId": "...",
  "createdAt": "timestamp"
}
```

👉 **Règle clé :**

> ❗ Aucun changement de stock sans mouvement associé

---

## 🏢 `/depots`

Gestion des entrepôts

```json
{
  "name": "SODIDA",
  "type": "sec | froid | congelé",
  "capacity": 5000,

  "totalCartons": 2500,
  "occupancyRate": 0.65
}
```

---

## 🚢 `/containers`

Couche logistique & import

```json
{
  "containerId": "MTDU1234567",

  "totalWeightKg": 28500,
  "totalValue": 114000,
  "currency": "EUR",

  "status": "in_transit | arrived | cleared",
  "eta": "2026-04-25"
}
```

👉 Sert de lien entre :

* Factures
* BL (Bill of Lading)
* Stock réel

---

# 🧠 3. Logique Métier (Core Engine)

## 🔁 Modèle Hybride

### 📦 Unitized (Cartons)

* unités + poids unitaire
* ex: 1425 cartons × 20kg

### ⚖️ Bulk (Vrac)

* uniquement poids total
* ex: 28,500 kg

---

## 🧮 Calculs centralisés

```js
// UNITIZED
totalWeightKg = units * unitWeight
totalValue = units * costPrice

// BULK
totalWeightKg = input.totalWeightKg
totalValue = totalWeightKg * costPrice
```

👉 **Une seule source de vérité → évite les incohérences UI**

---

## 🔐 Sécurité Financière

* Admin / Manager → accès complet
* Depot → valeurs masquées (••••)

---

## 🔄 Transactions atomiques

Chaque entrée utilise :

```js
writeBatch()
```

Flow :

1. Création movement (entry)
2. Création / update stock

---

# 🛠️ 4. Fonctionnalités Clés

## 🚢 A. Poste de Contrôle (ENTRÉES)

* 📸 Scan documents (caméra / upload)
* 🤖 Extraction IA (Gemini)

  * Container ID
  * Produits
  * Quantités
* 🌊 Tracking PAD (Port Dakar)
* 🔗 Liaison documents → stock → lots

---

## 📦 B. Gestion d'Inventaire Avancée

* SKU obligatoire (identité produit)
* LOT obligatoire (traçabilité)
* FEFO intégré (expiration dynamique)
* Support multi-unités (CTN / KG)

---

## 📊 C. CENTRE (Command Hub)

* UI orientée actions :

  * conteneurs à traiter
  * alertes FEFO
* Flux live des mouvements
* Priorités du jour (opérationnel réel)

---

## 🏢 D. Multi-Dépôts

* Gestion par entrepôt
* Zones / allées
* Suivi capacité & saturation

---

# ⚡ 5. Optimisations Techniques

## 📱 Mobile Performance

* FlatList optimisées
* UI légère (moins d'ombres)
* rendu conditionnel intelligent

---

## 🌐 Résilience Réseau

* Firestore offline persistence
* gestion cache + recovery automatique

---

## 🧱 Robustesse Data

* computeStockPayload() centralisé
* fallback pour anciens documents
* validation stricte des champs

---

# 🧩 6. Améliorations Récentes

* ✅ Fix Firebase persistence crash
* ✅ Fix permission-denied
* ✅ Synchronisation create/edit stock
* ✅ Clarification Unit vs Bulk
* ✅ UI dynamique (moins de répétition)
* ✅ Masquage financier sécurisé
* ✅ Cohérence entre Inventaire & Détail

---

# 🎯 7. Roadmap (Next Moves)

## 🔄 Opérations

* Sorties (livraisons clients)
* Transferts inter-dépôts

## 🔔 Intelligence

* Alertes FEFO automatiques (push)
* Stock critique & rotation lente

## 💰 Finance

* Conversion EUR → FCFA automatique
* Allocation coût container → produits

## 📄 Reporting

* Export PDF / CSV (douane, compta)

## 🖥️ Expansion

* Dashboard desktop (SaaS tiers)
* rôles + permissions avancées

---

# 🧠 Vision

DEPOTEK n'est pas un simple outil de stock.

C'est un système de flux complet :

> **Container → Entrée → Stock → Mouvement → Distribution**

---

# 👤 Builder

Habib Diallo
DEPOTEK — Logistics reimagined for Africa 🌍
