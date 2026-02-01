# Calories Tracking

Track food intake, calories, and body weight with proactive deficit monitoring.

## Features

- **Food Logging**: Log meals with LLM-estimated or user-provided calories
- **Custom Dishes**: Automatically learns user-defined dishes for quick logging
- **Weight Tracking**: Record weight measurements with weekly check-in reminders
- **Calorie Goal**: Manual target or TDEE-based calculation
- **Deficit Monitoring**: Neuron emits signals when calorie deficit becomes significant

## How It Works

### Food Logging Flow

1. User says "I had oatmeal for breakfast"
2. LLM estimates calories (150 kcal) with confidence (0.9)
3. Tool stores entry with source `llm_estimate`
4. If user provides calories ("my pasta, about 600 cal"), stored as `user_override`
5. User-provided dishes are auto-saved for future quick logging

### Neuron Behavior

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
User: "I had oatmeal for breakfast"
→ logs 150 kcal (LLM estimate, confidence 0.9)

User: "burger and fries for lunch"
→ logs 850 kcal (LLM estimate, confidence 0.8)

User: "my pasta, about 600 cal"
→ logs 600 kcal (user override, creates custom dish)

User: "what did I eat today?"
→ returns daily summary with breakdown by meal

User: "I weigh 75kg"
→ logs weight entry

User: "set my goal to 2000"
→ sets daily calorie target

User: "calculate my goal"
→ computes TDEE from user stats (weight, height, age, activity)
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

Existing fields used:
- `gender` - for BMR calculation
- `birthday` - to compute age (not stored separately)

## Technical Details

### Storage Keys

```
calories:food:YYYY-MM-DD   → FoodEntry[]     # Date-partitioned for efficiency
calories:dishes            → CustomDish[]    # User-defined quick-log dishes
calories:weights           → WeightEntry[]   # Weight history
calories:summary:YYYY-MM-DD → DailySummary   # Cached daily summaries
```

### Signals

| Signal | When | Priority |
|--------|------|----------|
| `calories:deficit` | Deficit > 50% after 2 PM | NORMAL |
| `calories:deficit` | Deficit > 80% after 6 PM | HIGH |

### Sleep-Aware Day Boundary

Food logging uses user's sleep cycle, not calendar midnight:
- 1:30 AM with wakeHour=7 → logs to previous date
- 8:00 AM with wakeHour=7 → logs to current date

This ensures late-night eating counts toward the correct day.

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

Goal adjustment: 500-1000 kcal/day based on target weight difference.
