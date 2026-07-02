# Deploying the AI food-scan function

The calorie tracker's "Snap your food" button posts a photo to a Supabase Edge
Function (`supabase/functions/food-scan/index.ts`), which calls Claude vision and
returns name + calories + macros. The Anthropic API key lives ONLY in Supabase
secrets — never in the client (the site is public on GitHub Pages). Until you
deploy this, the button shows a friendly "isn't set up yet" note; nothing breaks.

## One-time setup

1. **Get an Anthropic API key** — create one at https://console.anthropic.com
   (starts with `sk-ant-...`).

2. **Install the Supabase CLI** (not currently installed on this Mac):

   ```sh
   brew install supabase/tap/supabase
   ```

3. **Log in and link the project** (ref comes from `supabase-config.js`):

   ```sh
   cd ~/reptilift
   supabase login
   supabase link --project-ref uicqdjmdnatmgglkjurp
   ```

4. **Set the secret:**

   ```sh
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...your-key...
   ```

5. **Deploy the function** (JWT verification stays ON by default — do NOT pass
   `--no-verify-jwt`; the function requires a signed-in user so strangers can't
   burn your API budget):

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

Costs: each scan is one Claude vision call on a ~1024px JPEG — fractions of a
cent. The function rejects requests without a valid Supabase login (401).
