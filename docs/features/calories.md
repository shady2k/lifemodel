# Calories Tracking

Track food intake, calories, and body weight with catalog-based matching and proactive deficit monitoring.

## Features

- **Food Catalog**: Reusable `FoodItem` entries with structured nutritional basis
- **Pure Relational Model**: FoodEntry stores only `itemId`, calories computed at read time
- **Smart Matching**: Levenshtein-based fuzzy matching to prevent duplicates
- **Bulk Logging**: Log multiple foods in a single tool call
- **Multi-Day Search**: Find entries by food name across all history
- **Statistics**: 7-day calorie trends with weight tracking
- **Duplicate Detection**: Meal-type-aware — alerts only when same item logged in same meal
- **Weight Tracking**: Record weight measurements with weekly check-in reminders
- **Calorie Goal**: Manual target or TDEE-based calculation
- **Deficit Monitoring**: Neuron emits signals when calorie deficit becomes significant

## Architecture

### Data Model

```
FoodItem (catalog)          FoodEntry (log, pure relational)
┌──────────────────────┐    ┌──────────────────────┐
│ id                   │    │ id                   │
│ canonicalName        │◄───│ itemId               │
│ basis                │    │ portion              │
│  └ caloriesPer       │    │ mealType?            │
│  └ perQuantity       │    │ timestamp            │
│  └ perUnit           │    │ recipientId          │
│ measurementKind      │    └──────────────────────┘
│ recipientId          │
└──────────────────────┘

Calories NOT stored in FoodEntry — computed via resolveEntryCalories(entry, item)
```

**FoodItem** — Stable catalog entry with nutritional basis (source of truth):
```typescript
{
  id: "item_ml7q0340_xsl5go",
  canonicalName: "Бекон",
  measurementKind: "weight",
  basis: { caloriesPer: 425, perQuantity: 100, perUnit: "g" },
  createdAt: "2026-01-10T...",
  updatedAt: "2026-01-10T...",
  recipientId: "user_123"
}
```

**FoodEntry** — Log instance referencing a FoodItem (no calorie data stored):
```typescript
{
  id: "food_abc123",
  itemId: "item_ml7q0340_xsl5go",
  portion: { quantity: 45, unit: "g" },
  mealType: "breakfast",
  timestamp: "2026-01-10T08:00:00Z",
  recipientId: "user_123"
}
```

**Read-time resolution**:
```typescript
// Calories computed from item basis
calories = resolveEntryCalories(entry, item)
// = (45 / 100) * 425 = 191 cal
```

### Storage Keys

```
items                    → FoodItem[]       (catalog)
food:YYYY-MM-DD          → FoodEntry[]      (date-partitioned log)
weights                  → WeightEntry[]    (weight history)
schema_version           → 3                (migration state)
```

## Tool API

### Actions Overview

| Action | Description |
|--------|-------------|
| `log` | Log food entries (bulk support) |
| `list` | List entries for a date |
| `summary` | Daily calorie summary |
| `search` | Find entries by food name across all dates |
| `stats` | Multi-day statistics with weight trend |
| `goal` | Set or get calorie goal |
| `log_weight` | Record body weight |
| `delete` | Delete a food/weight entry |
| `update_item` | Modify a food item's name or basis |
| `delete_item` | Remove a food item (guarded) |

### Log Action

```typescript
calories({
  action: "log",
  entries: [
    {
      name: "Американо",
      portion: { quantity: 200, unit: "ml" },
      calories_estimate: 5,
      meal_type: "breakfast"
    }
  ]
})
```

**Response includes:**
- `results[]` — Per-entry status (matched/created/ambiguous)
- `dailySummary` — Enriched daily summary with byMealType breakdown
- `existingEntries` — Duplicates detected (same itemId + same meal type on same date)

**Response types:**

| Status | Meaning |
|--------|---------|
| `matched` | Existing FoodItem found, entry logged |
| `created` | New FoodItem created, entry logged |
| `ambiguous` | Multiple candidates, LLM must choose |

Example response:
```json
{
  "success": true,
  "results": [
    {
      "status": "matched",
      "entryId": "food_xxx",
      "itemId": "item_xxx",
      "canonicalName": "Американо",
      "calories": 5,
      "portion": { "quantity": 200, "unit": "ml" },
      "existingEntries": [
        { "entryId": "food_yyy", "calories": 5, "portion": { "quantity": 200, "unit": "ml" } }
      ]
    }
  ],
  "dailySummary": {
    "date": "2026-01-10",
    "totalCalories": 5,
    "goal": 2000,
    "remaining": 1995,
    "byMealType": {
      "breakfast": { "calories": 5, "count": 1 }
    },
    "entries": [
      { "name": "Американо", "calories": 5, "mealType": "breakfast", "portion": { "quantity": 200, "unit": "ml" } },
      { "name": "Бекон", "calories": 191, "mealType": "breakfast", "portion": { "quantity": 45, "unit": "g" }, "caloriesPer100g": 425 }
    ]
  }
}
```

### Resolving Ambiguous Matches

When `status: "ambiguous"`, the LLM should:
1. Ask the user which item they meant
2. Re-call `log` with `chooseItemId`:

```typescript
calories({
  action: "log",
  entries: [{
    name: "йогурт",
    chooseItemId: "item_1",  // Explicit selection
    portion: { quantity: 140, unit: "g" }
  }]
})
```

### Search Action

Find entries by food name across all history:

```typescript
calories({
  action: "search",
  queries: ["американо", "йогурт"],
  max_results: 50
})
```

Response:
```json
{
  "success": true,
  "results": [
    {
      "query": "американо",
      "matchedItems": [
        { "itemId": "item_xxx", "canonicalName": "Американо", "score": 1.0 }
      ],
      "entries": [
        { "date": "2026-01-10", "entryId": "food_1", "name": "Американо", "calories": 5, "portion": { "quantity": 200, "unit": "ml" } }
      ],
      "totalEntries": 15,
      "totalCalories": 75,
      "truncated": false
    }
  ]
}
```

### Stats Action

Multi-day statistics with weight trend:

```typescript
calories({
  action: "stats",
  days: 7  // default: 7, max: 30
})
```

Response:
```json
{
  "success": true,
  "period": { "from": "2026-02-09", "to": "2026-02-15" },
  "dailyCalories": [
    { "date": "2026-02-09", "totalCalories": 1850, "goal": 2000, "entryCount": 12, "byMealType": { "breakfast": 400, "lunch": 650, "dinner": 800 } }
  ],
  "averageCalories": 1920,
  "weightTrend": {
    "entries": [
      { "id": "weight_1", "weight": 75.0, "measuredAt": "2026-02-15T08:00:00Z" },
      { "id": "weight_2", "weight": 75.5, "measuredAt": "2026-02-08T08:00:00Z" }
    ],
    "change": -0.5,
    "direction": "down"
  },
  "streak": 7
}
```

### Update Item Action

Modify an existing food item:

```typescript
calories({
  action: "update_item",
  item_id: "item_xxx",  // or use name for fuzzy match
  new_name: "Американо с молоком",
  new_basis: { caloriesPer: 45, perQuantity: 200, perUnit: "ml" }
})
```

Response includes `affectedEntryCount` — all entries referencing this item automatically get updated calories (relational model).

### Delete Item Action

Remove a food item (with referential integrity guard):

```typescript
calories({
  action: "delete_item",
  item_id: "item_xxx"
})
```

**Rejection response** if entries reference the item:
```json
{
  "success": false,
  "error": "Cannot delete item: it has food entries referencing it",
  "referencedBy": {
    "count": 5,
    "dateRange": { "from": "2026-01-01", "to": "2026-02-15" }
  }
}
```

## LLM Instructions

```
ПРАВИЛА для calories tool:

1. В name указывай ТОЛЬКО название без количества:
   ✓ "Американо"
   ✗ "Американо 200мл"

2. Количество и единицы в portion:
   portion: { quantity: 200, unit: "ml" }

3. Единицы: g, kg, ml, l, item, slice, cup, serving

4. Если status="ambiguous", уточни у пользователя и повтори с chooseItemId

5. НЕ создавай новый продукт только из-за другой порции

6. Дата поддерживает относительные форматы: "today", "yesterday", "tomorrow", или YYYY-MM-DD

7. log response includes dailySummary — NEVER call summary after log

8. Если existingEntries присутствует в ответе, сообщи пользователю о возможных дубликатах (дубликат = тот же продукт в том же приёме пищи, разные приёмы = ОК)

9. search: поиск по названию еды по всей истории (максимум 5 запросов)

10. stats: статистика за несколько дней с трендом веса

11. update_item: изменить название или калорийность продукта

12. delete_item: удалить продукт (защита от удаления, если есть записи)
```

## Matching Algorithm

Uses Levenshtein distance with normalization:

1. **Normalize** — lowercase, ё→е, remove punctuation
2. **Remove stopwords** — "кофе", "чай", "напиток"
3. **Calculate similarity** — `1 - (distance / max_length)`
4. **Decide**:
   - `score >= 0.90` → `matched`
   - `score >= 0.80` with close runner-up → `ambiguous`
   - `score < 0.80` → `created`

## Schema Migration

The plugin runs a migration chain on first tool `execute()` call:

- **Lazy execution**: Triggered on first use, not at startup
- **Concurrency lock**: Module-level promise ensures single migration
- **Idempotent**: Safe to re-run after crash

### v2: Pure Relational Model

Removes `calories` field from FoodEntry (calories computed at read time via `resolveEntryCalories()`).

- **States**: `undefined` → `'migrating'` → `2`
- **Orphan recovery**: Entries referencing missing items get reconstructed placeholder items (crash-safe ordering: items persisted before entries)

### v3: Basis Normalization

Normalizes all weight-based item bases to per-100g canonical form via `normalizeBasis()`.

- Converts `{caloriesPer: 60, perQuantity: 20, perUnit: "g"}` → `{caloriesPer: 300, perQuantity: 100, perUnit: "g"}`
- Converts kg-based items to per-100g equivalent
- At read time, `caloriesPer100g` is computed via `normalizeBasis()` for any g/kg-based item (handles both old and new formats)

## Neuron Behavior

The `CaloriesDeficitNeuron` monitors calorie intake throughout the day:

- Reads food entries directly from plugin storage (no core changes)
- **Relational reads**: Loads items catalog, uses `resolveEntryCalories()`
- **Recipient filter**: Only counts entries for the neuron's user
- Stays dormant if no calorie goal is set
- Skips during sleep hours (alertness < 0.3)
- Pressure increases as day progresses
- Emits signal when deficit > 50% after 2 PM
- HIGH priority when deficit > 80% after 6 PM
- Refractory period: 2 hours (avoid nagging)
- Dormant after 11 PM (eating window closed)

### Weight Check-in

Weekly reminder scheduled based on user's wake hour pattern:
- Fires on Sunday, 1 hour after typical wake time
- References last weight and days since measurement
- Celebrates progress or offers support

## User Interaction Examples

```
User: "запиши американо и йогурт на завтрак"
→ log with entries=[
    {name:"Американо", portion:{quantity:200,unit:"ml"}, meal_type:"breakfast"},
    {name:"Йогурт", portion:{quantity:140,unit:"g"}, meal_type:"breakfast"}
  ]

User: "что я ел сегодня?"
→ list with date=today

User: "что было на завтраке вчера?"
→ list with date=yesterday, meal_type=breakfast

User: "сколько калорий осталось?"
→ summary with date=today

User: "найди все записи про кофе"
→ search with queries=["кофе"]

User: "покажи статистику за неделю"
→ stats with days=7

User: "я вешу 75кг"
→ log_weight with weight=75

User: "поставь цель 2000"
→ goal with daily_target=2000

User: "измени калорийность бекона на 450 ккал/100г"
→ update_item with name="Бекон", new_basis={caloriesPer:450, perQuantity:100, perUnit:"g"}
```

## Configuration

### User Properties (via core.remember)

| Property | Type | Description |
|----------|------|-------------|
| `weight_kg` | number | Current weight (20-500 kg) |
| `height_cm` | number | Height (50-300 cm) |
| `activity_level` | string | sedentary, light, moderate, active, very_active |
| `calorie_goal` | number | Daily target (manual or calculated) |
| `target_weight_kg` | number | Goal weight for TDEE adjustment |
| `sleep_hour` | number | Typical bedtime hour (0-23) |
| `wake_hour` | number | Typical wake hour (0-23) |
| `gender` | string | "male" or "female" |
| `birthday` | string | YYYY-MM-DD format |

## Technical Details

### Units

| Unit | Type | Examples |
|------|------|----------|
| `g`, `kg` | weight | "140г", "2кг" |
| `ml`, `l` | volume | "200мл", "1л" |
| `item`, `slice` | count | "2 шт", "3 куска" |
| `cup`, `tbsp`, `tsp` | measure | "1 чашка" |
| `serving` | portion | "1 порция" |

### Portion Calculation

Calories calculated from FoodItem basis at read time:

```typescript
// FoodItem: 425 cal per 100g
// Entry: 45g portion
calories = (45 / 100) * 425 = 191.25 → 191 cal
```

### Sleep-Aware Day Boundary

Food logging uses the **midpoint of the sleep period** as the day boundary, not calendar midnight.

| sleepHour | wakeHour | Cutoff | Example |
|-----------|----------|--------|---------|
| 23 (11 PM) | 7 AM | 3 AM | 2 AM → yesterday, 4 AM → today |
| 2 AM | 8 AM | 5 AM | 3 AM → yesterday, 6 AM → today |

### After-Midnight Entry Routing

Entries with timestamps before the cutoff are routed to the previous day:

```typescript
// User with sleepHour=23, wakeHour=7 (cutoff: 3 AM)
// Logging at 2 AM current time with timestamp "01:30"
// → Entry saved to yesterday's partition
```

Invalid timestamps fall back to the current date with a warning.

### TDEE Calculation

Uses Mifflin-St Jeor equation:
- Male: BMR = 10×weight + 6.25×height - 5×age + 5
- Female: BMR = 10×weight + 6.25×height - 5×age - 161

Activity multipliers:
- sedentary: 1.2
- light: 1.375
- moderate: 1.55
- active: 1.725
- very_active: 1.9
