# Calories Tracking

Track food intake, calories, and body weight with catalog-based matching and proactive deficit monitoring.

## Features

- **Food Catalog**: Reusable `FoodItem` entries with structured portions
- **Smart Matching**: Levenshtein-based fuzzy matching to prevent duplicates
- **Bulk Logging**: Log multiple foods in a single tool call
- **Weight Tracking**: Record weight measurements with weekly check-in reminders
- **Calorie Goal**: Manual target or TDEE-based calculation
- **Deficit Monitoring**: Neuron emits signals when calorie deficit becomes significant

## Architecture

### Data Model

```
FoodItem (catalog)     FoodEntry (log)
┌──────────────────┐   ┌──────────────────┐
│ id               │   │ id               │
│ canonicalName    │◄──│ itemId           │
│ basis            │   │ calories         │
│ measurementKind  │   │ portion          │
│ portionDefs?     │   │ mealType?        │
│ recipientId      │   │ timestamp        │
└──────────────────┘   └──────────────────┘
```

**FoodItem** — Stable catalog entry with nutritional basis:
```typescript
{
  id: "item_xxx",
  canonicalName: "Американо",
  measurementKind: "volume",
  basis: { caloriesPer: 5, perQuantity: 200, perUnit: "ml" }
}
```

**FoodEntry** — Log instance referencing a FoodItem:
```typescript
{
  id: "food_xxx",
  itemId: "item_xxx",  // → FoodItem
  calories: 5,
  portion: { quantity: 200, unit: "ml" },
  mealType: "breakfast",
  timestamp: "2024-01-01T08:00:00Z"
}
```

### Tool API

Single `log` action with bulk support:

```typescript
calories({
  action: "log",
  entries: [
    {
      name: "Американо",
      portion: { quantity: 200, unit: "ml" },
      calories_estimate: 5,
      meal_type: "breakfast"
    },
    {
      name: "Йогурт Teos Греческий 2%",
      portion: { quantity: 140, unit: "g" },
      calories_estimate: 94
    }
  ]
})
```

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
      "portion": { "quantity": 200, "unit": "ml" }
    },
    {
      "status": "ambiguous",
      "originalName": "йогурт",
      "candidates": [
        { "itemId": "item_1", "canonicalName": "Йогурт Греческий", "score": 0.85 },
        { "itemId": "item_2", "canonicalName": "Йогурт Фруктовый", "score": 0.82 }
      ],
      "suggestedPortion": { "quantity": 140, "unit": "g" }
    }
  ]
}
```

### Resolving Ambiguous Matches

When `status: "ambiguous"`, the LLM should:
1. Ask the user which item they meant
2. Re-call `log` with `chooseItemId`:

```typescript
calories({
  action: "log",
  entries: [
    {
      name: "йогурт",
      chooseItemId: "item_1",  // Explicit selection
      portion: { quantity: 140, unit: "g" }
    }
  ]
})
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

## Neuron Behavior

The `CaloriesDeficitNeuron` monitors calorie intake throughout the day:

- Reads food entries directly from plugin storage (no core changes)
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

User: "сколько калорий осталось?"
→ summary with date=today

User: "я вешу 75кг"
→ log_weight with weight=75

User: "поставь цель 2000"
→ goal with daily_target=2000
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

### Storage Keys

```
calories:items           → FoodItem[]      # Food catalog
calories:food:YYYY-MM-DD → FoodEntry[]     # Date-partitioned log
calories:weights         → WeightEntry[]   # Weight history
```

### Units

| Unit | Type | Examples |
|------|------|----------|
| `g`, `kg` | weight | "140г", "2кг" |
| `ml`, `l` | volume | "200мл", "1л" |
| `item`, `slice` | count | "2 шт", "3 куска" |
| `cup`, `tbsp`, `tsp` | measure | "1 чашка" |
| `serving` | portion | "1 порция" |

### Portion Calculation

Calories are calculated from the FoodItem basis:

```typescript
// FoodItem: 59 cal per 100g
// Entry: 140g portion
calories = (140 / 100) * 59 = 82.6 → 83 cal
```

### Sleep-Aware Day Boundary

Food logging uses the **midpoint of the sleep period** as the day boundary, not calendar midnight.

| sleepHour | wakeHour | Cutoff | Example |
|-----------|----------|--------|---------|
| 23 (11 PM) | 7 AM | 3 AM | 2 AM → yesterday, 4 AM → today |
| 2 AM | 8 AM | 5 AM | 3 AM → yesterday, 6 AM → today |

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

