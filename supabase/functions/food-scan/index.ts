// ============================================================================
// REPTILIFT EDGE FUNCTION: food-scan
// ----------------------------------------------------------------------------
// Takes a photo of food (base64 JPEG from the calorie tracker), asks an AI
// vision model to identify it and estimate calories + macros, and returns
// structured JSON. API keys live here as Supabase secrets — NEVER in the
// client (the site is public on GitHub Pages).
//
// TWO PROVIDERS, pick by which secret you set (see DEPLOY-FOOD-SCAN.md):
//   • ANTHROPIC_API_KEY  → Claude vision (paid credits; used if set)
//   • GEMINI_API_KEY     → Google Gemini (has a FREE tier; fallback)
// Both return the exact same JSON shape to the client.
//
// Request:  POST { image: "<base64, no data: prefix>", media_type: "image/jpeg" }
//           Headers: Authorization: Bearer <supabase user JWT>, apikey: <anon>
// Response: { is_food, name, portion, calories, protein_g, carbs_g, fat_g,
//             confidence }
// Errors:   401 not signed in · 400 bad request · 502 model/upstream trouble
// ============================================================================
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const PROMPT =
  "Identify the food in this photo and estimate its nutritional content for the visible portion. If multiple items, treat them as one meal and sum the totals. If it is not food, set is_food to false.";

// ---- CORS ------------------------------------------------------------------
// Auth (JWT) is the real gate on the API budget; CORS just needs to let the
// GitHub Pages site, local dev and file:// testing (Origin: null) through.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const ok =
    origin.endsWith(".github.io") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1") ||
    origin === "null" || origin === "";
  return {
    "Access-Control-Allow-Origin": ok && origin ? origin : "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// ---- provider: Anthropic Claude (strict JSON schema output) -----------------
async function scanWithClaude(apiKey: string, image: string, media_type: string) {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type, data: image } },
        { type: "text", text: PROMPT },
      ],
    }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            is_food: { type: "boolean" },
            name: { type: "string", description: "Short name of the food/meal, e.g. 'Chicken burrito'" },
            portion: { type: "string", description: "Estimated visible portion, e.g. '1 large burrito (~450g)'" },
            calories: { type: "integer" },
            protein_g: { type: "integer" },
            carbs_g: { type: "integer" },
            fat_g: { type: "integer" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["is_food", "name", "portion", "calories", "protein_g", "carbs_g", "fat_g", "confidence"],
          additionalProperties: false,
        },
      },
    },
  });
  if (response.stop_reason === "refusal") {
    return { error: "The model declined to analyze that image. Try a clearer photo of the food." };
  }
  const block = response.content.find((b: { type: string }) => b.type === "text");
  if (!block || !("text" in block)) return { error: "No result from the model. Try again." };
  return { result: JSON.parse((block as { text: string }).text) };
}

// ---- provider: Google Gemini (FREE tier; structured JSON via responseSchema)
async function scanWithGemini(apiKey: string, image: string, media_type: string) {
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: media_type, data: image } },
            { text: PROMPT },
          ],
        }],
        generationConfig: {
          maxOutputTokens: 1024,
          response_mime_type: "application/json",
          response_schema: {
            type: "OBJECT",
            properties: {
              is_food: { type: "BOOLEAN" },
              name: { type: "STRING", description: "Short name of the food/meal, e.g. 'Chicken burrito'" },
              portion: { type: "STRING", description: "Estimated visible portion, e.g. '1 large burrito (~450g)'" },
              calories: { type: "INTEGER" },
              protein_g: { type: "INTEGER" },
              carbs_g: { type: "INTEGER" },
              fat_g: { type: "INTEGER" },
              confidence: { type: "STRING", enum: ["low", "medium", "high"] },
            },
            required: ["is_food", "name", "portion", "calories", "protein_g", "carbs_g", "fat_g", "confidence"],
          },
        },
      }),
    },
  );
  if (r.status === 429) {
    return { error: "The free scanning quota is briefly maxed out — try again in a minute." };
  }
  if (!r.ok) {
    console.error("gemini http", r.status, await r.text().catch(() => ""));
    return { error: "Food scanning hit a snag upstream. Try again in a moment." };
  }
  const j = await r.json();
  const cand = j?.candidates?.[0];
  if (!cand || cand.finishReason === "SAFETY") {
    return { error: "The model declined to analyze that image. Try a clearer photo of the food." };
  }
  const text = cand?.content?.parts?.find((p: { text?: string }) => typeof p.text === "string")?.text;
  if (!text) return { error: "No result from the model. Try again." };
  return { result: JSON.parse(text) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  // ---- auth: require a valid Supabase user JWT (stops randoms burning budget)
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(req, 401, { error: "Sign in to scan food." });
  try {
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data, error } = await supa.auth.getUser(jwt);
    if (error || !data?.user) return json(req, 401, { error: "Sign in to scan food." });
  } catch (_e) {
    return json(req, 401, { error: "Sign in to scan food." });
  }

  // ---- body validation
  let image = "", media_type = "image/jpeg";
  try {
    const body = await req.json();
    image = String(body.image ?? "");
    media_type = String(body.media_type ?? "image/jpeg");
  } catch (_e) {
    return json(req, 400, { error: "Bad request body." });
  }
  if (!image || image.startsWith("data:")) {
    return json(req, 400, { error: "Send base64 image data without the data: prefix." });
  }
  if (image.length > 8_000_000) return json(req, 400, { error: "Image too large." });
  if (!MEDIA_TYPES.has(media_type)) return json(req, 400, { error: "Unsupported image type." });

  // ---- pick a provider by which secret exists (Anthropic wins if both)
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!anthropicKey && !geminiKey) {
    return json(req, 502, { error: "Food scanning isn't configured yet — no AI key set (see DEPLOY-FOOD-SCAN.md)." });
  }
  try {
    const out = anthropicKey
      ? await scanWithClaude(anthropicKey, image, media_type)
      : await scanWithGemini(geminiKey!, image, media_type);
    if ("error" in out) return json(req, 502, { error: out.error });
    return json(req, 200, out.result);
  } catch (e) {
    console.error("food-scan error:", e);
    return json(req, 502, { error: "Food scanning hit a snag upstream. Try again in a moment." });
  }
});
