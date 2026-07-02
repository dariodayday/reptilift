# Deploying the AI food-scan function

The calorie tracker's "Snap your food" button posts a photo to a Supabase Edge
Function (`supabase/functions/food-scan/index.ts`), which calls an AI vision
model and returns name + calories + macros. API keys live ONLY in Supabase
secrets — never in the client (the site is public on GitHub Pages). Until you
deploy this, the button shows a friendly "isn't set up yet" note; nothing breaks.

The function supports **two providers** — set whichever secret you have.
If both are set, Anthropic is used.

| Provider | Secret | Cost |
| --- | --- | --- |
| Google Gemini | `GEMINI_API_KEY` | **FREE tier** (rate-limited; no card needed) |
| Anthropic Claude | `ANTHROPIC_API_KEY` | prepaid credits ($5 minimum) |

## Step 1 — get a key (pick ONE)

**FREE — Google Gemini:**
1. Go to https://aistudio.google.com/apikey and sign in with any Google account.
2. Click **Create API key** — no card required. Copy the key (starts with `AIza`).
   The free tier is rate-limited (per-minute and per-day caps) but plenty for
   personal meal logging; if a scan hits the cap the app says "try again in a
   minute."

**PAID — Anthropic Claude:**
1. https://console.anthropic.com → Billing → buy the $5 minimum credits.
2. API Keys → Create Key → copy the `sk-ant-...` key.

## Step 2 — link the Supabase CLI (one time)

The CLI is already installed (`brew install supabase/tap/supabase`). Run:

```sh
cd ~/reptilift
supabase login
supabase link --project-ref uicqdjmdnatmgglkjurp
```

(`login` opens the browser — click Authorize. If `link` asks for a database
password, just press Enter.)

## Step 3 — set the secret and deploy

Free Gemini key:

```sh
supabase secrets set GEMINI_API_KEY=AIza...your-key...
```

…or paid Anthropic key:

```sh
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...your-key...
```

Then deploy (JWT verification stays ON by default — do NOT pass
`--no-verify-jwt`; the function requires a signed-in user so strangers can't
burn your quota):

```sh
supabase functions deploy food-scan
```

## Smoke test

Sign into the app once (cloud sync), then grab your access token from the
browser console on the site:

```js
JSON.parse(localStorage.getItem("sb-uicqdjmdnatmgglkjurp-auth-token")).access_token
```

Then (the tiny base64 below is a 1×1 PNG — expect `"is_food": false`):

```sh
curl -s -X POST "https://uicqdjmdnatmgglkjurp.supabase.co/functions/v1/food-scan" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "apikey: <SUPA_ANON from supabase-config.js>" \
  -H "Content-Type: application/json" \
  -d '{"image":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","media_type":"image/png"}'
```

A real food photo returns e.g.:

```json
{ "is_food": true, "name": "Chicken burrito", "portion": "1 large burrito (~450g)",
  "calories": 650, "protein_g": 38, "carbs_g": 62, "fat_g": 26, "confidence": "medium" }
```

The function rejects requests without a valid Supabase login (401). To switch
providers later, just set the other secret with `supabase secrets set` —
it takes effect on the next scan, no redeploy needed.
