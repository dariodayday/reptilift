// Reptilift v3.16 — earn your beast rank per exercise from your MMR.
// v3.16 adds a first-run ONBOARDING wizard (#onboard). Shown ONCE to brand-new
// users after the intro finishes — detected as NOT profile.onboarded AND no real
// data (no bodyweight, no sets, no workouts). Existing users are implicitly flagged
// (profile.onboarded=true) so it never appears for them. The flag lives inside the
// synced reptilift_profile, so a cloud save with onboarded=true suppresses it on new
// devices. Five skippable steps (welcome → name → bodyweight → optional cloud sign-up
// → finish) with progress dots; bodyweight is required to advance (uses applyBodyweight);
// the cloud step auto-drops when Supabase isn't configured. Finishing/Skip removes the
// overlay and lands on Log/Menu. Triggered only from inside introTimers/init (load-safe).
// v3.13 adds FRIENDS + LEADERBOARD (requires login). Two new Supabase tables:
// public_profiles (one publicly-readable row per user: username, name, small avatar,
// overall_mmr, beast_id, streak — powers leaderboards) and friendships (request
// edges: requester/addressee/status). A unique @username (lowercased, in
// reptilift_profile.username, already synced) lets friends find you; the claim modal
// validates 3–20 chars of [a-z0-9_] and handles taken-handle collisions gracefully.
// publishPublicProfile() upserts your public row on login (once a username is known),
// after a profile Save, and after finishWorkout (debounced, fail-silent offline).
// The #friends-page (Menu → "👥 Friends & Leaderboard") has Friends / Requests /
// Leaderboard sub-tabs, friend add/accept/decline/cancel/unfriend over RLS-secured
// friendships, a read-only friend card, and a Friends|Global leaderboard. All reads/
// writes go through the existing `supa` client under the user's auth; logged-out shows
// a friendly prompt to the Account page and never errors. No new localStorage keys.
// v3.12 adds permanent ACHIEVEMENTS / badges. A static ACHIEVEMENTS list (id, name,
// desc, icon, check(ctx)) is evaluated by checkAchievements() against current game
// state; newly-earned ones are stamped with today's date in the new reptilift_achievements
// key (in SYNC_KEYS, so it cloud-syncs) and surfaced via a light celebratory toast.
// Once earned, always earned. Lifetime Scales earned is tracked in quests.lifetime.coins
// (existing key, no new storage) to feed the High Roller badge. Badges show on the
// Profile (featured preview + count) and a dedicated #achievements-page grid.
// v3.10 adds a "Favorite lift" to the Profile: chosen from a muscle-group-grouped
// dropdown of the full catalog, stored as profile.favoriteExercise (exId) inside the
// existing reptilift_profile object (auto-syncs, no new key). Shown read-only in the
// profile stats with its best beast/MMR when available; hidden if unset or stale.
// v3.9 adds a dedicated Profile page (#profile-page) reached from the top avatar
// chip + a Menu button. Profile picture (downscaled to 256px JPEG data URL),
// display name, and bio all live inside the existing reptilift_profile object so
// they sync to the cloud automatically (no new key). Bodyweight is editable there
// too and still feeds logBodyweight()/the trend chart. The avatar also shows on
// the shareable rank card. Account & Cloud Sync stays one tap away from Profile.
// v3.6 adds a Progress screen (inline-SVG charts of overall MMR over time, per-lift
// MMR, bodyweight trend, and per-session volume — all reconstructed from stored
// sets/workouts) plus a shareable rank card rendered to <canvas> (native Web Share
// with a PNG file when available, download fallback otherwise). New key
// reptilift_bwlog stores dated bodyweight entries; it's in SYNC_KEYS too.
// v3.5 holds rank-up celebrations until you FINISH a workout, then plays them one
// by one (deduped per lift: start-of-session beast → final beast) before the recap,
// and pre-fills each exercise's set rows with your last-used weight + reps
// (reptilift_lastsets; routine target reps win, weight falls back to last-used).
// v3.4 moves Account/Cloud Sync to its own dedicated page (#account-page),
// reached from the top ☁️ chip; it's not a bottom tab so no tab is active there.
// v3.2 adds optional email+password accounts + Supabase cloud sync (see the
// "cloud sync" section near the bottom). Fully local/guest experience is
// unchanged when Supabase isn't configured or nobody is logged in.
// MMR is a 0–800 strength-standards rating. Each exercise has an anchor curve of
// oneRM targets (calibrated at 180 lb bodyweight) that map to fixed MMR band tops
// [50,125,225,350,500,650,750,800]; your estimated 1RM (Epley) is interpolated
// against that curve and clamped to 0–800. Anchors scale linearly with bodyweight
// (required oneRM = baseline × bodyweight/180). Best MMR per lift is saved; your
// OVERALL MMR is the simple AVERAGE of every ranked lift's best per-exercise MMR
// (each logged exercise counts equally; unlogged lifts don't count).

// ===== cloud-sync hook: localStorage.setItem auto-push override =====
// Installed FIRST so every existing/future write to a "reptilift_" key can
// trigger a debounced cloud push — without us having to edit every save site.
// It only schedules a push when (a) a user is logged in (cloudUser set later)
// and (b) we're NOT mid-apply of a cloud save (cloudSuppress guards that loop).
// Non-reptilift writes (incl. Supabase's own session keys) pass straight through.
const SYNC_KEYS = [
  "reptilift_achievements", "reptilift_active", "reptilift_bests", "reptilift_bwlog",
  "reptilift_customex", "reptilift_inventory", "reptilift_lastsets", "reptilift_profile",
  "reptilift_quests", "reptilift_routines", "reptilift_sets", "reptilift_sound",
  "reptilift_streak", "reptilift_wallet", "reptilift_workouts",
];
let cloudUser = null;        // set to the Supabase user once logged in
let cloudSuppress = false;   // true while applyCloud() is writing keys (don't echo back)
(function installSetItemHook() {
  const raw = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    raw(key, value);
    if (!cloudSuppress && cloudUser && typeof key === "string" && key.indexOf("reptilift_") === 0) {
      try { if (typeof scheduleCloudPush === "function") scheduleCloudPush(); } catch (e) {}
    }
  };
})();

// ===== the food chain (by MMR band, 0–800 strength-standards scale) =====
// mmrMin/mmrMax carve the 0–800 MMR scale into eight bands, one per beast; the
// top beast is open-ended (>= 751). classify() maps an MMR into its band.
const BEASTS = [
  { id: "chud",        emoji: "🐔", name: "Chud Chicken",      color: "#d98c3f", mmrMin: 0,   mmrMax: 51,       say: "Nothing moved. The couch claims another." },
  { id: "atrophy",     emoji: "🐊", name: "Atrophy Alligator", color: "#46b07a", mmrMin: 51,  mmrMax: 126,      say: "Barely a load. The gator shrinks." },
  { id: "endurance",   emoji: "🦅", name: "Endurance Eagle",   color: "#f2c14e", mmrMin: 126, mmrMax: 226,      say: "Light and breezy. Soaring." },
  { id: "hypertrophy", emoji: "🐺", name: "Wired Wolf",        color: "#cf6a3a", mmrMin: 226, mmrMax: 351,      say: "Real working weight. The wolf feeds." },
  { id: "strength",    emoji: "🦍", name: "Grinded Gorilla",   color: "#e0563b", mmrMin: 351, mmrMax: 501,      say: "Heavy iron. Built like a gorilla." },
  { id: "egolift",     emoji: "🐘", name: "Egolift Elephant",  color: "#9aa6b2", mmrMin: 501, mmrMax: 651,      say: "That's a LOT of plates. Ego mode." },
  { id: "rhino",       emoji: "🦏", name: "Raging Rhino",      color: "#7c83ff", mmrMin: 651, mmrMax: 751,      say: "Plates bending the bar. The rhino charges." },
  { id: "octopus",     emoji: "🐙", name: "Optimal Octopus",   color: "#b455f0", mmrMin: 751, mmrMax: Infinity, say: "Peak form, max load. Optimal in every way." },
];
const MMR_MAX = 800;   // displayed/stored MMR is clamped here
const byId = (id) => BEASTS.find((b) => b.id === id);
const tierOf = (id) => BEASTS.findIndex((b) => b.id === id) + 1;
// classify by MMR band: lower bound inclusive, upper exclusive (top is open-ended).
// null/undefined MMR (bodyweight not set) returns null so callers can show a dash.
const classify = (mmr) => {
  if (mmr == null) return null;
  return BEASTS.find((b) => mmr >= b.mmrMin && mmr < b.mmrMax) || BEASTS[BEASTS.length - 1];
};
// display label for a beast's MMR band, e.g. "0–50" or "751–800" (top shown closed).
const beastRange = (b) =>
  b.mmrMax === Infinity ? `${b.mmrMin}–${MMR_MAX}` : `${b.mmrMin}–${b.mmrMax - 1}`;

// ===== MMR strength standards (0–800) =====
// The MMR bands top out at these fixed values; an exercise's anchor oneRM curve
// lists the oneRM (at 180 lb bodyweight) that EARNS each band top, plus (0 -> 0).
const MMR_BAND_TOPS = [50, 125, 225, 350, 500, 650, 750, 800];
// Shared curve shape: fraction of the Optimal-Octopus top oneRM (T) at each band
// top. Every exercise except the big three derives its curve as T × SHAPE.
const MMR_SHAPE = [0.25, 0.36, 0.475, 0.59, 0.705, 0.82, 0.915, 1.0];

// Big three get the user's exact anchor curves (oneRM at 180 lb -> band tops).
const MMR_CURVES = {
  bench:    [95, 135, 185, 225, 275, 325, 365, 400],
  squat:    [135, 185, 245, 315, 365, 425, 475, 520],
  deadlift: [155, 225, 295, 365, 435, 500, 550, 600],
};

// Optimal-Octopus top oneRM (T) at 180 lb for every other exercise. Each anchor
// curve is built as T × MMR_SHAPE. Values come from the user's explicit standards
// where given, otherwise from standard strength ratios relative to the big three:
//   pressing variants ~0.8× flat bench, squat variants ~0.85× back squat,
//   RDL ~0.9× deadlift, rows ~ user/0.7–1× bench, isolations much lower.
// Rep/bodyweight standards were converted to a oneRM via estimate1RM at 180 lb
// (Epley) so equivalence holds: e.g. pull-ups 25 reps -> 330, dips 40 -> 399,
// push-ups 100 -> 499. Edit any number here to retune that lift's whole curve.
const MMR_TOP = {
  // --- Chest --- (flat bench T=400 lives in MMR_CURVES)
  inclinebench: 320, declinebench: 380, dbbench: 150, inclinedb: 130,
  chestpress: 320, pecdeck: 200, cablefly: 160, dbfly: 120,
  pushup: 499,            // user: 100 reps bodyweight @180
  dip: 399,              // user: 40 reps bodyweight @180 (also covers weighted dips)
  // --- Back --- (deadlift T=600 lives in MMR_CURVES)
  rackpull: 700, row: 315, pendlay: 300, tbar: 315, dbrow: 150,
  cablerow: 280, latpulldown: 300, machinerow: 300,
  pullup: 330,           // user: 25 reps bodyweight @180 (also covers weighted pull-ups)
  chinup: 340, backext: 250,
  // --- Shoulders ---
  ohp: 250,              // user: shoulder press T=250
  dbshoulder: 110, arnold: 110, shouldermach: 250,
  lateralraise: 60, frontraise: 55, reardelt: 55, facepull: 90,
  cablelatraise: 75, reversefly: 60,
  uprightrow: 135, shrug: 405,
  // --- Legs --- (back squat T=520 lives in MMR_CURVES)
  frontsquat: 440, legpress: 1000, hacksquat: 600, smithsquat: 480,
  rdl: 540, legext: 320, legcurl: 250, lunge: 240, bulgarian: 220,
  hipthrust: 700, gobletsquat: 180, calfraise: 500,
  bwsquat: 408,          // bodyweight squat: ~50 reps @180
  // --- Arms ---
  curl: 185,             // user: barbell curl T=185
  dbcurl: 80, hammercurl: 85, preacher: 150, cablecurl: 150, ezcurl: 175,
  pushdown: 150,         // user: tricep pushdown T=150
  skullcrusher: 165, overheadtri: 150, closegrip: 320, kickback: 60,
  // --- Core ---
  cablecrunch: 250, abmachine: 280, situp: 135, russiantwist: 100,
  hangingleg: 144,       // hanging leg raise: ~30 reps bodyweight @180
  // --- Olympic ---
  powerclean: 315, cleanjerk: 360, snatch: 290,
  // --- Other / fallback ---
  machine: 300,
};
const MMR_TOP_DEFAULT = 300;   // guard for any exercise id missing from the table

// Build a 9-point (oneRM, mmr) anchor curve for an exercise at 180 lb.
// Big three use their exact curve; everyone else uses T × MMR_SHAPE.
function mmrAnchors(ex) {
  const curve = ex && MMR_CURVES[ex.id];
  if (curve) return curve;
  const T = (ex && MMR_TOP[ex.id]) || MMR_TOP_DEFAULT;
  return MMR_SHAPE.map((f) => Math.round(T * f));
}

// ===== exercises =====
const BASE_EXERCISES = [
  // Chest
  { id: "bench",        name: "Barbell Bench Press",     type: "load", group: "Chest" },
  { id: "inclinebench", name: "Incline Bench Press",     type: "load", group: "Chest" },
  { id: "declinebench", name: "Decline Bench Press",     type: "load", group: "Chest" },
  { id: "dbbench",      name: "Dumbbell Bench Press",    type: "load", group: "Chest" },
  { id: "inclinedb",    name: "Incline Dumbbell Press",  type: "load", group: "Chest" },
  { id: "chestpress",   name: "Chest Press Machine",     type: "load", group: "Chest" },
  { id: "pecdeck",      name: "Pec Deck / Machine Fly",  type: "load", group: "Chest" },
  { id: "cablefly",     name: "Cable Fly / Crossover",   type: "load", group: "Chest" },
  { id: "dbfly",        name: "Dumbbell Fly",            type: "load", group: "Chest" },
  { id: "pushup",       name: "Push-ups",                type: "bodyweight", factor: 0.64, group: "Chest" },
  { id: "dip",          name: "Dips",                    type: "bodyweight", factor: 0.95, group: "Chest" },
  // Back
  { id: "deadlift",     name: "Deadlift",                type: "load", group: "Back" },
  { id: "rackpull",     name: "Rack Pull",               type: "load", group: "Back" },
  { id: "row",          name: "Barbell Row",             type: "load", group: "Back" },
  { id: "pendlay",      name: "Pendlay Row",             type: "load", group: "Back" },
  { id: "tbar",         name: "T-Bar Row",               type: "load", group: "Back" },
  { id: "dbrow",        name: "Dumbbell Row",            type: "load", group: "Back" },
  { id: "cablerow",     name: "Seated Cable Row",        type: "load", group: "Back" },
  { id: "latpulldown",  name: "Lat Pulldown",            type: "load", group: "Back" },
  { id: "machinerow",   name: "Machine Row",             type: "load", group: "Back" },
  { id: "pullup",       name: "Pull-ups",                type: "bodyweight", factor: 1.0, group: "Back" },
  { id: "chinup",       name: "Chin-ups",                type: "bodyweight", factor: 1.0, group: "Back" },
  { id: "backext",      name: "Back Extension",          type: "bodyweight", factor: 0.55, group: "Back" },
  // Shoulders
  { id: "ohp",          name: "Overhead Press",          type: "load", group: "Shoulders" },
  { id: "dbshoulder",   name: "Dumbbell Shoulder Press", type: "load", group: "Shoulders" },
  { id: "arnold",       name: "Arnold Press",            type: "load", group: "Shoulders" },
  { id: "shouldermach", name: "Shoulder Press Machine",  type: "load", group: "Shoulders" },
  { id: "lateralraise", name: "Lateral Raise",           type: "load", group: "Shoulders" },
  { id: "cablelatraise",name: "Cable Lateral Raise",     type: "load", group: "Shoulders" },
  { id: "frontraise",   name: "Front Raise",             type: "load", group: "Shoulders" },
  { id: "reardelt",     name: "Rear Delt Fly",           type: "load", group: "Shoulders" },
  { id: "reversefly",   name: "Reverse Fly",             type: "load", group: "Shoulders" },
  { id: "facepull",     name: "Face Pull",               type: "load", group: "Shoulders" },
  { id: "uprightrow",   name: "Upright Row",             type: "load", group: "Shoulders" },
  { id: "shrug",        name: "Shrugs",                  type: "load", group: "Shoulders" },
  // Legs
  { id: "squat",        name: "Barbell Back Squat",      type: "load", group: "Legs" },
  { id: "frontsquat",   name: "Front Squat",             type: "load", group: "Legs" },
  { id: "legpress",     name: "Leg Press",               type: "load", group: "Legs" },
  { id: "hacksquat",    name: "Hack Squat",              type: "load", group: "Legs" },
  { id: "smithsquat",   name: "Smith Machine Squat",     type: "load", group: "Legs" },
  { id: "rdl",          name: "Romanian Deadlift",       type: "load", group: "Legs" },
  { id: "legext",       name: "Leg Extension",           type: "load", group: "Legs" },
  { id: "legcurl",      name: "Leg Curl",                type: "load", group: "Legs" },
  { id: "lunge",        name: "Walking Lunge",           type: "load", group: "Legs" },
  { id: "bulgarian",    name: "Bulgarian Split Squat",   type: "load", group: "Legs" },
  { id: "hipthrust",    name: "Hip Thrust",              type: "load", group: "Legs" },
  { id: "gobletsquat",  name: "Goblet Squat",            type: "load", group: "Legs" },
  { id: "calfraise",    name: "Calf Raise",              type: "load", group: "Legs" },
  { id: "bwsquat",      name: "Bodyweight Squat",        type: "bodyweight", factor: 0.85, group: "Legs" },
  // Arms
  { id: "curl",         name: "Barbell Curl",            type: "load", group: "Arms" },
  { id: "dbcurl",       name: "Dumbbell Curl",           type: "load", group: "Arms" },
  { id: "hammercurl",   name: "Hammer Curl",             type: "load", group: "Arms" },
  { id: "preacher",     name: "Preacher Curl",           type: "load", group: "Arms" },
  { id: "cablecurl",    name: "Cable Curl",              type: "load", group: "Arms" },
  { id: "ezcurl",       name: "EZ-Bar Curl",             type: "load", group: "Arms" },
  { id: "pushdown",     name: "Tricep Pushdown",         type: "load", group: "Arms" },
  { id: "skullcrusher", name: "Skull Crushers",          type: "load", group: "Arms" },
  { id: "overheadtri",  name: "Overhead Tricep Ext.",    type: "load", group: "Arms" },
  { id: "closegrip",    name: "Close-Grip Bench",        type: "load", group: "Arms" },
  { id: "kickback",     name: "Tricep Kickback",         type: "load", group: "Arms" },
  // Core
  { id: "cablecrunch",  name: "Cable Crunch",            type: "load", group: "Core" },
  { id: "abmachine",    name: "Ab Crunch Machine",       type: "load", group: "Core" },
  { id: "hangingleg",   name: "Hanging Leg Raise",       type: "bodyweight", factor: 0.4, group: "Core" },
  { id: "situp",        name: "Weighted Sit-ups",        type: "load", group: "Core" },
  { id: "russiantwist", name: "Russian Twist",           type: "load", group: "Core" },
  // Olympic
  { id: "powerclean",   name: "Power Clean",             type: "load", group: "Olympic" },
  { id: "cleanjerk",    name: "Clean & Jerk",            type: "load", group: "Olympic" },
  { id: "snatch",       name: "Snatch",                  type: "load", group: "Olympic" },
  // Other
  { id: "machine",      name: "Machine / Other",         type: "load", group: "Other" },
];

// ===== state =====
let profile = JSON.parse(localStorage.getItem("reptilift_profile") || '{"bodyweight":null}');
// guard the profile shape: older saves only had {bodyweight}. name/bio/avatar are
// optional strings; avatar is a (possibly large) data URL. Normalize defensively so
// nothing downstream throws on a missing/corrupt field.
if (!profile || typeof profile !== "object") profile = { bodyweight: null };
if (typeof profile.name !== "string") profile.name = "";
if (typeof profile.bio !== "string") profile.bio = "";
if (typeof profile.avatar !== "string") profile.avatar = "";
if (typeof profile.favoriteExercise !== "string") profile.favoriteExercise = "";  // exId of chosen favorite lift
if (typeof profile.username !== "string") profile.username = "";   // public @handle (Friends/Leaderboard); synced inside reptilift_profile
// first-run onboarding flag — lives INSIDE the synced profile so it travels with a
// cloud save (logging in on a new device that has onboarded=true won't re-show the
// wizard). Plain-guard only here (load-order safe; the check runs from init below).
if (typeof profile.onboarded !== "boolean") profile.onboarded = false;
// normalize the handle defensively at load with PLAIN guards only (no helper calls —
// keeps load-order safe): lowercase, strip to [a-z0-9_], cap at 20.
profile.username = profile.username.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
// cosmetics live inside the synced profile (reptilift_profile, in SYNC_KEYS) so owned +
// equipped cosmetics auto-push to the cloud and come down on other devices. Shape:
//   { owned: { <itemId>: 1, ... }, equipped: { theme, frame, nameColor, border } }
// Default = nothing equipped (current look). Normalize with PLAIN guards only here —
// no helper calls at load time (load-order safe; see the catalog/COSMETICS below).
if (!profile.cosmetics || typeof profile.cosmetics !== "object") profile.cosmetics = {};
if (!profile.cosmetics.owned || typeof profile.cosmetics.owned !== "object") profile.cosmetics.owned = {};
if (!profile.cosmetics.equipped || typeof profile.cosmetics.equipped !== "object") profile.cosmetics.equipped = {};
["theme", "frame", "nameColor", "border"].forEach((slot) => {
  if (typeof profile.cosmetics.equipped[slot] !== "string") profile.cosmetics.equipped[slot] = "";
});
let sets = JSON.parse(localStorage.getItem("reptilift_sets") || "[]");   // every set, all time
let bests = JSON.parse(localStorage.getItem("reptilift_bests") || "{}"); // exId -> {beast, oneRM, date}
let customEx = JSON.parse(localStorage.getItem("reptilift_customex") || "[]");
let soundOn = localStorage.getItem("reptilift_sound") !== "off";  // default ON; gates SFX + haptics
// dated bodyweight history for the Progress trend. [{date:"YYYY-MM-DD", bw:Number}]
// (one entry per day — same-day changes overwrite). Seeded below from the current
// profile bodyweight if the log is empty but a bodyweight is already set.
let bwLog = JSON.parse(localStorage.getItem("reptilift_bwlog") || "[]");
if (!Array.isArray(bwLog)) bwLog = [];
function saveBwLog() { localStorage.setItem("reptilift_bwlog", JSON.stringify(bwLog)); }
// record today's bodyweight, replacing any existing entry for today; keeps the log
// sorted by date. No-op for falsy/invalid weights.
function logBodyweight(bw) {
  if (!bw || bw <= 0) return;
  const d = todayStr();
  const i = bwLog.findIndex((e) => e.date === d);
  if (i >= 0) bwLog[i].bw = bw; else bwLog.push({ date: d, bw });
  bwLog.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  saveBwLog();
}
// NOTE: the one-time seed from profile.bodyweight runs in the init block at the
// bottom of the file — todayStr()/fmtDate() aren't defined yet at this point, so
// calling logBodyweight() here would throw a TDZ error and blank the whole app.

// ===== economy state ("Scales" 🦎 — the in-app currency) =====
// wallet:   { balance } running coin balance.
// inventory:{ restorer, freeze, booster } owned consumable counts + booster flag.
// quests:   { claimed:{id:true}, lifetime:{...}, daily:{date, ...counters, claimed:{}} }
// streakx:  { bridges:[YYYY-MM-DD], lastFreeze } days the streak was rescued by an
//           item (a freeze auto-spent on a gap, or a restorer manually applied).
// All shapes are guarded by safeParse so corrupt/missing data falls back cleanly.
function safeParse(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === "object" ? v : fallback; }
  catch (e) { return fallback; }
}
let wallet    = safeParse("reptilift_wallet", { balance: 0 });
let inventory = safeParse("reptilift_inventory", { restorer: 0, freeze: 0, booster: 0 });
let quests    = safeParse("reptilift_quests", { claimed: {}, lifetime: {}, daily: {} });
let streakx   = safeParse("reptilift_streak", { bridges: [], lastFreeze: null });
// normalize shapes (in case an older/partial object was stored)
if (typeof wallet.balance !== "number" || wallet.balance < 0) wallet.balance = 0;
["restorer", "freeze", "booster"].forEach((k) => { if (typeof inventory[k] !== "number" || inventory[k] < 0) inventory[k] = 0; });
inventory.boosterArmed = !!inventory.boosterArmed;   // doubles next finish's coins
if (!quests.claimed || typeof quests.claimed !== "object") quests.claimed = {};
if (!quests.lifetime || typeof quests.lifetime !== "object") quests.lifetime = {};
if (!quests.daily || typeof quests.daily !== "object") quests.daily = {};
if (!Array.isArray(streakx.bridges)) streakx.bridges = [];

// ===== achievements state (permanent one-time badges) =====
// reptilift_achievements: { earned: { <id>: ISOdateString } }. Once an id is in
// `earned` it stays forever (never un-earned even if stats later drop). In SYNC_KEYS.
// Shape is normalized defensively with plain guards (no helper calls at load time).
let achievements = safeParse("reptilift_achievements", { earned: {} });
if (!achievements.earned || typeof achievements.earned !== "object") achievements.earned = {};
function saveAchievements() { localStorage.setItem("reptilift_achievements", JSON.stringify(achievements)); }

function saveEconomy() {
  localStorage.setItem("reptilift_wallet", JSON.stringify(wallet));
  localStorage.setItem("reptilift_inventory", JSON.stringify(inventory));
  localStorage.setItem("reptilift_quests", JSON.stringify(quests));
  localStorage.setItem("reptilift_streak", JSON.stringify(streakx));
}
const COIN = "🦎";                            // currency glyph (reptile scales)
const CUR = "Scales";                         // currency name
// adjust the balance; when EARNING (n>0) also accrue a lifetime-earned counter in
// quests.lifetime.coins (existing synced key — no new storage) for the High Roller
// achievement. Spending (n<0) never decrements the lifetime total.
const addCoins = (n) => {
  wallet.balance = Math.max(0, wallet.balance + n);
  if (n > 0) quests.lifetime.coins = (quests.lifetime.coins || 0) + n;
};
function refreshWallet() {                     // update every on-screen balance chip
  document.querySelectorAll("[data-wallet]").forEach((el) => { el.textContent = wallet.balance.toLocaleString(); });
}

const EXERCISES = () => [...BASE_EXERCISES, ...customEx];
const exById = (id) => EXERCISES().find((e) => e.id === id);

function save() {
  localStorage.setItem("reptilift_profile", JSON.stringify(profile));
  localStorage.setItem("reptilift_sets", JSON.stringify(sets));
  localStorage.setItem("reptilift_bests", JSON.stringify(bests));
  localStorage.setItem("reptilift_customex", JSON.stringify(customEx));
}

// ===== helpers =====
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayStr = () => fmtDate(new Date());
function prettyDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const today = todayStr(), yest = fmtDate(new Date(Date.now() - 864e5));
  if (str === today) return "Today";
  if (str === yest) return "Yesterday";
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function estimate1RM(ex, { bodyweight, added, weight, reps }) {
  const load = ex.type === "bodyweight" ? bodyweight * ex.factor + added : weight;
  return Math.round(load * (1 + reps / 30)); // Epley
}
// MMR (0–800) via piecewise-linear interpolation of a oneRM against an exercise's
// anchor curve. Anchors are calibrated at 180 lb and scaled by bodyweight/180
// (required oneRM = baseline × bw/180), so the same relative effort ranks the same
// across bodyweights. Returns null when bodyweight is unknown (callers show a dash).
function mmrOf(oneRM, bw, ex) {
  if (!bw || bw <= 0) return null;
  if (!(oneRM > 0)) return 0;
  const scale = bw / 180;
  const anchors = mmrAnchors(ex);                 // 8 oneRM values @180 lb
  // x = oneRM at each band top (scaled to this bodyweight), preceded by (0,0).
  const xs = [0, ...anchors.map((a) => a * scale)];
  const ys = [0, ...MMR_BAND_TOPS];
  if (oneRM >= xs[xs.length - 1]) return MMR_MAX;  // above top anchor -> clamp 800
  for (let i = 1; i < xs.length; i++) {
    if (oneRM < xs[i]) {
      const span = xs[i] - xs[i - 1] || 1;
      const t = (oneRM - xs[i - 1]) / span;
      return Math.round(Math.min(MMR_MAX, ys[i - 1] + t * (ys[i] - ys[i - 1])));
    }
  }
  return MMR_MAX;
}
// recompute a stored best's MMR from its oneRM under the current bodyweight/curve.
function mmrForBest(exId, oneRM) {
  return mmrOf(oneRM, profile.bodyweight, exById(exId));
}
// INVERSE of mmrOf: the oneRM you'd need to hit a target MMR on this exercise at
// the current bodyweight. Same piecewise-linear curve, solved for x. Returns null
// when bodyweight is unknown. Mirrors mmrOf's anchor scaling exactly.
function oneRMForMMR(targetMMR, bw, ex) {
  if (!bw || bw <= 0) return null;
  const scale = bw / 180;
  const xs = [0, ...mmrAnchors(ex).map((a) => a * scale)];
  const ys = [0, ...MMR_BAND_TOPS];
  if (targetMMR <= 0) return 0;
  if (targetMMR >= ys[ys.length - 1]) return xs[xs.length - 1];
  for (let i = 1; i < ys.length; i++) {
    if (targetMMR <= ys[i]) {
      const span = ys[i] - ys[i - 1] || 1;
      const t = (targetMMR - ys[i - 1]) / span;
      return xs[i - 1] + t * (xs[i] - xs[i - 1]);
    }
  }
  return xs[xs.length - 1];
}
// Concrete target to reach a band-floor MMR on `ex`: invert to the required oneRM,
// then back out a human goal. Weighted lifts -> a weight to hit (oneRM ≈ weight at
// 1 rep). Bodyweight lifts -> reps needed at current bodyweight (Epley inverted:
// reps = (oneRM/load - 1) * 30, where load = bw*factor). Returns null if no bw.
function nextRankTarget(ex, targetMMR, bw) {
  const need = oneRMForMMR(targetMMR, bw, ex);
  if (need == null) return null;
  if (ex.type === "bodyweight") {
    const load = bw * ex.factor;
    if (load <= 0) return null;
    const reps = Math.max(1, Math.ceil((need / load - 1) * 30));
    return { kind: "reps", reps };
  }
  return { kind: "weight", weight: Math.max(5, Math.round(need / 5) * 5) };  // round to nearest 5 lb plate
}
const todaySets = () => sets.filter((s) => s.date === todayStr());

// overall rank = the beast band your overall MMR falls into (MMR-driven).
function overallBeast() {
  return classify(overallMMR());
}
// overall MMR = the simple average of EVERY ranked lift's best per-exercise MMR.
// Each exercise with a stored best MMR contributes equally; lifts you've never
// logged (or that have no numeric mmr) simply don't count. Returns null when
// bodyweight is unset OR no lift has a numeric MMR yet (so the rating shows a dash).
function overallMMR() {
  if (!profile.bodyweight) return null;
  let total = 0, n = 0;
  for (const id in bests) {
    const rec = bests[id];
    if (rec && typeof rec.mmr === "number") { total += rec.mmr; n++; }
  }
  if (!n) return null;
  return Math.round(total / n);
}

// A day "counts" toward the streak if a set was logged that day OR an item bridged
// it (a spent Streak Freeze / Streak Restorer records the date in streakx.bridges).
function streakDays() {
  const days = new Set(sets.map((s) => s.date));
  (streakx.bridges || []).forEach((d) => days.add(d));
  return days;
}
function computeStreak() {
  const days = streakDays();
  if (!days.size) return 0;
  let cur = new Date();
  if (!days.has(fmtDate(cur))) {
    cur = new Date(Date.now() - 864e5);            // allow streak to hold if nothing logged yet today
    if (!days.has(fmtDate(cur))) return 0;
  }
  let streak = 0;
  while (days.has(fmtDate(cur))) { streak++; cur = new Date(cur.getTime() - 864e5); }
  return streak;
}

// Auto-consume a Streak Freeze when EXACTLY one missed day sits between the live
// streak and today, bridging that gap so the streak survives. Runs on load + after
// finishing a workout. Only fires when there's a real broken streak to save and a
// freeze in inventory; bridges a single day (the most recent gap day).
function maybeAutoFreeze() {
  if (!(inventory.freeze > 0)) return false;
  const days = streakDays();
  if (!days.size) return false;
  const yest = fmtDate(new Date(Date.now() - 864e5));
  const today = todayStr();
  // streak only breaks once today/yesterday is empty; we bridge the gap day just
  // before the most recent worked-out day so the chain reconnects to today.
  if (days.has(today) || days.has(yest)) return false;   // streak still alive — nothing to save
  // a freeze only covers ONE missed day: the streak must reach exactly two days ago.
  const twoAgo = fmtDate(new Date(Date.now() - 2 * 864e5));
  if (!days.has(twoAgo)) return false;          // gap too wide for a single freeze
  inventory.freeze--; streakx.bridges.push(yest); streakx.lastFreeze = yest;
  saveEconomy();
  return true;
}

// ===== navigation =====
function switchTab(name) {
  // account-page is a dedicated screen reached via the cloud chip, NOT a bottom
  // tab — so no tab gets the active state while it's showing (clean, nothing
  // looks half-selected). Every real tab still matches by data-tab.
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === name));
  if (name === "home") renderHome();
  if (name === "ranks") renderYourRanks();
  if (name === "routines") renderRoutines();
  if (name === "history") renderHistory();
  if (name === "shop") renderShop();
  if (name === "quests") renderQuests();
  if (name === "progress") renderProgress();
  if (name === "profile-page") renderProfile();
  if (name === "achievements-page") renderAchievements();
  if (name === "friends-page") { try { if (typeof renderFriendsPage === "function") renderFriendsPage(); } catch (e) {} }
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
document.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.go)));

// ===== profile bodyweight =====
const bwInput = document.getElementById("bw");
if (profile.bodyweight) bwInput.value = profile.bodyweight;
// Apply a new bodyweight value (shared by the Log bodyweight input AND the Profile
// page's bodyweight field so the two stay in sync). Logs a dated entry for the
// trend chart and recomputes every best's MMR/beast under the new bodyweight.
function applyBodyweight(val) {
  profile.bodyweight = parseInt(val, 10) || null;
  if (profile.bodyweight) logBodyweight(profile.bodyweight);   // dated entry for the trend chart
  // anchor curves scale with bodyweight, so recompute every best's MMR from its
  // stored oneRM, then re-derive the (MMR-driven) beast rank for each record.
  if (profile.bodyweight) {
    for (const k in bests) {
      const v = bests[k];
      const m = mmrForBest(k, v.oneRM);
      if (m != null) v.mmr = m;
      const nb = classify(v.mmr);
      v.beast = nb ? nb.id : null;
    }
  }
  // keep both bodyweight inputs in sync
  if (bwInput && document.activeElement !== bwInput) bwInput.value = profile.bodyweight || "";
  const peBw = document.getElementById("peBw");
  if (peBw && document.activeElement !== peBw) peBw.value = profile.bodyweight || "";
  save();
  renderHome();
}
bwInput.addEventListener("change", () => applyBodyweight(bwInput.value));

// ===== rank-up sound + haptics =====
// Self-contained: SFX are synthesized with the Web Audio API (no files/network).
// soundOn gates both the cue and vibration; persisted in localStorage (default ON).
const soundToggle = document.getElementById("soundToggle");
soundToggle.checked = soundOn;
soundToggle.addEventListener("change", () => {
  soundOn = soundToggle.checked;
  localStorage.setItem("reptilift_sound", soundOn ? "on" : "off");
  if (soundOn) blip();   // tiny confirmation chirp when (re)enabled
});

// Lazily create/resume one shared AudioContext on a user gesture (logging a set
// is a gesture, but resume() anyway to dodge autoplay suspension). Returns null
// if Web Audio is unavailable.
let audioCtx = null;
function getCtx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}

// One enveloped oscillator note. freq Hz, starts at t (sec), runs dur sec, peak gain.
function note(ctx, freq, t, dur, peak = 0.18, type = "triangle") {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.02);      // fast attack
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);     // smooth decay
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// Tiny UI chirp (toggle confirmation).
function blip() {
  const ctx = getCtx(); if (!ctx) return;
  try { note(ctx, 880, ctx.currentTime, 0.12, 0.12); } catch (e) {}
}

// Rising fanfare for a rank-up swap: a quick major arpeggio (~0.6s).
function playRankUpSfx() {
  const ctx = getCtx(); if (!ctx) return;
  try {
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>   // C5 E5 G5 C6
      note(ctx, f, t + i * 0.09, 0.22, 0.18, "triangle"));
  } catch (e) {}
}

// Egg-hatch: a short "crack" (square noise burst, falling) then a bright chime.
function playHatchSfx() {
  const ctx = getCtx(); if (!ctx) return;
  try {
    const t = ctx.currentTime;
    const crack = ctx.createOscillator(), cg = ctx.createGain();
    crack.type = "square";
    crack.frequency.setValueAtTime(320, t);
    crack.frequency.exponentialRampToValueAtTime(90, t + 0.14);  // pitch-drop = crack
    cg.gain.setValueAtTime(0.16, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    crack.connect(cg).connect(ctx.destination);
    crack.start(t); crack.stop(t + 0.18);
    [659.25, 987.77, 1318.5].forEach((f, i) =>           // E5 B5 E6 sparkle
      note(ctx, f, t + 0.18 + i * 0.08, 0.28, 0.16, "triangle"));
  } catch (e) {}
}

// Celebratory haptics (no-op where unsupported, e.g. desktop / iOS Safari).
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}

// ===== active workout session =====
let workout = JSON.parse(localStorage.getItem("reptilift_active") || "null");
let workouts = JSON.parse(localStorage.getItem("reptilift_workouts") || "[]");
let lastSets = JSON.parse(localStorage.getItem("reptilift_lastsets") || "{}"); // exId -> [{lbs,reps,added}] from last session (PREV column)
let routines = JSON.parse(localStorage.getItem("reptilift_routines") || "[]"); // [{id,name,exercises:[{exId,sets,reps}]}]
const saveWorkout = () => {
  localStorage.setItem("reptilift_active", JSON.stringify(workout));
  localStorage.setItem("reptilift_workouts", JSON.stringify(workouts));
  localStorage.setItem("reptilift_lastsets", JSON.stringify(lastSets));
};
const saveRoutines = () => localStorage.setItem("reptilift_routines", JSON.stringify(routines));
// Most recent remembered values for an exercise, used to pre-fill new set rows.
// lastSets[exId] is the list of completed sets from the lift's last session; the
// LAST element is the most recent actual performance. Returns { lbs, reps } where
// lbs is the entered weight (load lifts) or the added weight (bodyweight lifts),
// or null if this lift has no history yet.
function lastSetFor(exId) {
  const arr = lastSets[exId];
  if (!Array.isArray(arr) || !arr.length) return null;
  const s = arr[arr.length - 1];
  if (!s) return null;
  const lbs = s.lbs != null && s.lbs !== "" ? s.lbs : (s.added != null && s.added !== "" ? s.added : "");
  return { lbs, reps: s.reps != null ? s.reps : "" };
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s % 60)).padStart(2, "0")}`;

// visual icon per exercise (stand-in for a movement diagram)
const GROUP_ICON = { Chest: "🏋️", Back: "🚣", Shoulders: "🤾", Legs: "🦵", Arms: "💪", Core: "🔥", Olympic: "🏋️", Other: "⚙️", Custom: "⭐" };
function exIcon(e) {
  if (!e) return "🏋️";
  if (e.type === "bodyweight") return "🤸";
  return GROUP_ICON[e.group] || "🏋️";
}

// exercise thumbnail: prefer a per-exercise image (exercises/<id>.png),
// fall back to the body-part beast (exercises/<group>.png), then the icon.
function exThumb(e) {
  let g = (e && e.group ? e.group : "Other").toLowerCase();
  if (g === "custom") g = "other";
  const id = e ? e.id : "";
  const v = "65";   // bump when exercise images change, to bust browser cache
  return `<span class="thumb">` +
    `<img src="exercises/${id}.png?v=${v}" alt="" loading="lazy" ` +
    `onerror="if(!this.dataset.f){this.dataset.f=1;this.src='exercises/${g}.png?v=${v}';}else{this.remove();}" /></span>`;
}

// custom exercise-picker overlay (scrollable list with a thumbnail beside each name)
const exPicker = document.getElementById("exPicker");
document.getElementById("addExBtn").addEventListener("click", () => openPicker("workout"));
document.getElementById("exPickerClose").addEventListener("click", closePicker);
exPicker.addEventListener("click", (e) => { if (e.target === exPicker) closePicker(); });
document.getElementById("exSearch").addEventListener("input", (e) => renderPicker(e.target.value));
document.getElementById("exCustomBtn").addEventListener("click", addCustomExercise);

// pickerMode: "workout" (add to active session) or "routine" (add to routine editor)
let pickerMode = "workout";
function openPicker(mode) {
  pickerMode = mode === "routine" ? "routine" : "workout";
  document.getElementById("exSearch").value = "";
  renderPicker("");
  exPicker.classList.remove("hidden");
}
function closePicker() { exPicker.classList.add("hidden"); }
// route a picked exercise to the right destination based on pickerMode.
function pickExercise(exId) {
  if (pickerMode === "routine") addExerciseToRoutine(exId);
  else addExerciseToWorkout(exId);
}

function renderPicker(filter) {
  const list = document.getElementById("exPickerList"); list.innerHTML = "";
  const f = (filter || "").trim().toLowerCase();
  const order = ["Chest", "Back", "Shoulders", "Legs", "Arms", "Core", "Olympic", "Custom", "Other"];
  const groups = {};
  EXERCISES().forEach((e) => { if (f && !e.name.toLowerCase().includes(f)) return; (groups[e.group || "Custom"] ||= []).push(e); });
  const keys = Object.keys(groups).sort((a, b) => ((order.indexOf(a) + 1) || 99) - ((order.indexOf(b) + 1) || 99));
  if (!keys.length) { list.innerHTML = `<p class="empty">No match.</p>`; return; }
  keys.forEach((g) => {
    const h = document.createElement("div"); h.className = "pick-group"; h.textContent = g; list.appendChild(h);
    groups[g].forEach((e) => {
      const r = document.createElement("button"); r.className = "pick-row"; r.type = "button";
      r.innerHTML = `${exThumb(e)}<span class="pick-name">${e.name}</span>`;
      r.addEventListener("click", () => { pickExercise(e.id); closePicker(); });
      list.appendChild(r);
    });
  });
}

function addCustomExercise() {
  const name = (prompt("Exercise / machine name?") || "").trim();
  if (!name) return;
  const isBw = confirm("Is this a BODYWEIGHT exercise?\n\nOK = bodyweight (push-ups, pull-ups…)\nCancel = weighted (bar / machine)");
  const id = "c_" + Date.now();
  customEx.push(isBw ? { id, name, type: "bodyweight", factor: 0.7, group: "Custom" } : { id, name, type: "load", group: "Custom" });
  save(); pickExercise(id); closePicker();
}

document.getElementById("startBtn").addEventListener("click", () => startWorkout());
document.getElementById("finishBtn").addEventListener("click", finishWorkout);
document.getElementById("restSkip").addEventListener("click", () => { if (workout) { workout.restEnd = null; saveWorkout(); tick(); } });
document.getElementById("restPlus").addEventListener("click", () => { if (workout && workout.restEnd) { workout.restEnd += 30000; saveWorkout(); tick(); } });

// start a fresh session. Optionally seed it from a routine's exercise list.
// `events` collects per-session rank-ups / MMR PRs (filled in completeSet) so the
// post-workout review can summarise progress. `overallBefore` snapshots the overall
// MMR/beast at start to detect an overall rank change by finish time.
function startWorkout(routine) {
  const ob = overallBeast();
  workout = {
    start: Date.now(), restEnd: null, exercises: [], events: [],
    routineName: routine ? routine.name : null,
    overallBefore: { mmr: overallMMR(), beast: ob ? ob.id : null },
  };
  if (routine && Array.isArray(routine.exercises)) {
    routine.exercises.forEach((re) => {
      const ex = exById(re.exId);
      if (!ex) return;   // tolerate an exId no longer in the catalog
      const n = Math.max(1, parseInt(re.sets, 10) || 1);
      // reps precedence: a routine's target rep count wins; otherwise fall back to
      // the last-remembered reps for this lift. Weight always pre-fills from
      // last-used (routines don't store weight). startBeast snapshots the lift's
      // rank at session start so a finish-time celebration can show old→final.
      const last = lastSetFor(ex.id);
      const reps = re.reps != null && re.reps !== "" ? String(re.reps)
        : (last && last.reps != null ? String(last.reps) : "");
      const lbs = last && last.lbs != null && last.lbs !== "" ? String(last.lbs) : "";
      const sb = bests[ex.id] ? classify(bests[ex.id].mmr) : null;
      workout.exercises.push({
        exId: ex.id, exName: ex.name, type: ex.type, rest: 90, restOn: true, collapsed: false,
        startBeast: sb ? sb.id : null,
        sets: Array.from({ length: n }, () => ({ lbs, reps, added: "", done: false })),
      });
    });
  }
  saveWorkout(); renderWorkout(); startTicker();
}
function finishWorkout() {
  if (!workout) return;
  const review = summarizeWorkout(workout);   // built BEFORE we file/clear the session
  let setCount = 0;
  workout.exercises.forEach((exo) => {
    const done = exo.sets.filter((s) => s.done);
    setCount += done.length;
    if (done.length) lastSets[exo.exId] = done.map((s) => ({ lbs: s.lbs, reps: s.reps, added: s.added || 0 }));
  });
  if (setCount) {
    const top = workout.exercises.flatMap((e) => e.sets.filter((s) => s.done).map((s) => s.beast)).map(byId).filter(Boolean)
      .sort((a, b) => tierOf(b.id) - tierOf(a.id))[0];
    workouts.unshift({ date: todayStr(), start: workout.start, dur: Math.round((Date.now() - workout.start) / 1000), setCount, beast: top ? top.id : null });
    // economy: this counts as a finished workout for quests, and earns Scales.
    trackDaily("workouts"); trackLifetime("workouts");
    awardWorkoutCoins(review);   // sets review.coins (idempotent); used by showReview
  }
  // build the queue of rank-up celebrations to play one by one BEFORE the review.
  // Dedupe per exercise: one celebration from the lift's rank at session start
  // (exo.startBeast) to its FINAL rank now, even if it crossed several bands. The
  // `old` arg decides the variant: null startBeast => egg hatch, else old→new swap.
  const queue = buildCelebrationQueue(workout);
  workout = null; saveWorkout(); stopTicker(); renderWorkout();
  maybeAutoFreeze();             // protect the streak if a freeze applies
  // celebrations first (sequential), then the recap. Zero rank-ups => straight to review.
  // Suppress the review's own SFX only when celebrations actually played their sounds.
  playCelebrations(queue, () => showReview(review, queue.length > 0));
  // stats changed (MMR/streak) — refresh the public leaderboard row. Debounced &
  // guarded; no-op when logged out / no username / offline.
  try { if (typeof publishPublicProfile === "function") publishPublicProfile(); } catch (e) {}
  // push any duel progress I made this session to my active duels' *_current columns.
  try { if (typeof updateMyDuels === "function") updateMyDuels(); } catch (e) {}
}

// Collect one finish-time celebration per exercise that ranked up this session.
// Final rank = the lift's current best beast; starting rank = the snapshot taken
// when the exercise entered the session (exo.startBeast). Only emit when the
// final tier is strictly above the start tier. Ordered low→high tier so the
// biggest reveal lands last. Skips abandoned exercises (no completed sets).
function buildCelebrationQueue(w) {
  if (!w) return [];
  const out = [];
  (w.exercises || []).forEach((exo) => {
    if (!exo.sets.some((s) => s.done)) return;
    const ex = exById(exo.exId); if (!ex) return;
    const rec = bests[exo.exId];
    const finalBeast = rec ? classify(rec.mmr) : null;
    if (!finalBeast) return;
    const startTier = exo.startBeast ? tierOf(exo.startBeast) : 0;
    if (tierOf(finalBeast.id) <= startTier) return;   // no net rank-up this session
    const old = exo.startBeast ? byId(exo.startBeast) : null;   // null => egg hatch
    out.push({ ex, beast: finalBeast, old });
  });
  return out.sort((a, b) => tierOf(a.beast.id) - tierOf(b.beast.id));
}

// effective load for one completed set, consistent with estimate1RM / completeSet:
// bodyweight moves use bw*factor + added; weighted moves use the entered weight.
function setLoad(ex, s, bw) {
  if (!ex) return 0;
  if (ex.type === "bodyweight") return (bw || 0) * ex.factor + (parseInt(s.added, 10) || parseInt(s.lbs, 10) || 0);
  return parseInt(s.lbs, 10) || 0;
}

// Build the post-workout review model from a (still-active) workout object.
// Pulls rank-ups / MMR PRs out of workout.events (recorded in completeSet) and
// compares overallBefore vs. now to flag an overall rank change.
function summarizeWorkout(w) {
  const bw = profile.bodyweight || 0;
  let setCount = 0, volume = 0;
  const exDone = [];   // { ex, name, sets:[done...], bestSet, newMmr }
  const events = w.events || [];
  const prByEx = {};   // exId -> highest new-best mmr event this session
  const rankupByEx = {};
  events.forEach((e) => {
    if (e.kind === "pr") prByEx[e.exId] = Math.max(prByEx[e.exId] || 0, e.mmr || 0);
    if (e.kind === "rankup") {
      const cur = rankupByEx[e.exId];
      if (!cur || tierOf(e.to) > tierOf(cur.to)) rankupByEx[e.exId] = e;
    }
  });
  // align the review's rank-up rows with the finish-time celebrations: show the
  // jump as session-start beast → final beast (not the last intermediate band),
  // so a lift that crossed several bands reads as one clean old→new.
  (w.exercises || []).forEach((exo) => {
    const ru = rankupByEx[exo.exId];
    if (ru) ru.from = exo.startBeast || null;
  });
  let topBeast = null;
  (w.exercises || []).forEach((exo) => {
    const ex = exById(exo.exId);
    const done = exo.sets.filter((s) => s.done);
    if (!done.length) return;
    setCount += done.length;
    let bestSet = null;
    done.forEach((s) => {
      volume += setLoad(ex, s, bw) * (parseInt(s.reps, 10) || 0);
      if (!bestSet || (s.oneRM || 0) > (bestSet.oneRM || 0)) bestSet = s;
      const b = byId(s.beast);
      if (b && (!topBeast || tierOf(b.id) > tierOf(topBeast.id))) topBeast = b;
    });
    exDone.push({
      exId: exo.exId, name: exo.exName, bestSet,
      newMmr: prByEx[exo.exId] != null ? prByEx[exo.exId] : null,
      rankup: rankupByEx[exo.exId] || null,
    });
  });
  // overall rank change
  const ob = overallBeast(), obId = ob ? ob.id : null;
  const before = w.overallBefore || { mmr: null, beast: null };
  const overallChanged = !!obId && (before.beast == null || tierOf(obId) > tierOf(before.beast));
  return {
    empty: setCount === 0,
    routineName: w.routineName || null,
    dur: Math.round((Date.now() - w.start) / 1000),
    setCount, exCount: exDone.length, volume: Math.round(volume),
    exercises: exDone,
    rankups: Object.values(rankupByEx).sort((a, b) => tierOf(b.to) - tierOf(a.to)),
    topBeast: topBeast ? topBeast.id : null,
    overallChanged, overallBeast: obId, overallMmr: overallMMR(),
  };
}

// ===== post-workout review =====
// Celebratory recap shown at finish time. The workout is already filed into history
// by the time this runs; "Done" simply dismisses and returns to the Menu.
const reviewModal = document.getElementById("reviewModal");
// `silent` suppresses the review's own rank-up SFX/haptics — used when sequential
// finish-time celebrations already played their sounds, so we don't double up.
function showReview(r, silent) {
  if (!r) return;
  const body = document.getElementById("reviewBody");
  const fmtDur = (s) => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  if (r.empty) {
    body.innerHTML = `
      <div class="rv-emoji">🥚</div>
      <h2 class="rv-title">No sets logged</h2>
      <p class="rv-say">The beast went hungry. Log some sets next time to climb the food chain.</p>`;
    reviewModal.classList.remove("hidden");
    return;
  }
  const tb = byId(r.topBeast) || BEASTS[0];
  const accent = tb.color;
  // overall rank change banner (most prominent)
  let overallHtml = "";
  if (r.overallChanged) {
    const ob = byId(r.overallBeast);
    overallHtml = `<div class="rv-overall" style="--c:${ob.color}">
      <div class="rv-overall-tag">★ NEW OVERALL RANK</div>
      <div class="rv-overall-beast">${ob.emoji} ${ob.name}</div>
      <div class="rv-overall-mmr">Overall MMR ${r.overallMmr != null ? r.overallMmr.toLocaleString() : "—"}</div>
    </div>`;
  }
  // rank-ups this session
  let rankupHtml = "";
  if (r.rankups.length) {
    rankupHtml = `<div class="rv-section"><div class="rv-shead">Ranked up</div>` +
      r.rankups.map((e) => {
        const to = byId(e.to), from = e.from ? byId(e.from) : null;
        const fromTxt = from ? `${from.emoji} ${from.name}` : "🥚 Unranked";
        return `<div class="rv-rankup" style="--c:${to.color}">
          <span class="rv-ru-ex">${e.exName}</span>
          <span class="rv-ru-arrow">${fromTxt} → <b>${to.emoji} ${to.name}</b></span>
        </div>`;
      }).join("") + `</div>`;
  }
  // exercises done + best set / new MMR
  const exHtml = `<div class="rv-section"><div class="rv-shead">Exercises trained</div>` +
    r.exercises.map((e) => {
      const bs = e.bestSet;
      const detail = bs ? (bs.beast ? `${byId(bs.beast).emoji} ` : "") +
        (parseInt(bs.lbs, 10) || parseInt(bs.added, 10) ? `${bs.lbs || bs.added} × ${bs.reps}` : `× ${bs.reps}`) : "—";
      const pr = e.newMmr != null ? `<span class="rv-pr">PR · MMR ${e.newMmr.toLocaleString()}</span>` : "";
      return `<div class="rv-exrow">
        <span class="rv-ex-name">${e.name}</span>
        <span class="rv-ex-meta">${detail} ${pr}</span>
      </div>`;
    }).join("") + `</div>`;

  // coins earned this session
  const coinHtml = r.coins ? `<div class="rv-coins">+${r.coins.toLocaleString()} ${COIN} ${CUR} earned${r.boosted ? ` <span class="rv-boost">⚡ 2× boost</span>` : ""}</div>` : "";
  body.innerHTML = `
    <div class="rv-emoji" style="text-shadow:0 0 26px ${accent}">${tb.emoji}</div>
    <h2 class="rv-title">Session complete</h2>
    <p class="rv-say">${r.routineName ? r.routineName + " · " : ""}Top beast: <b style="color:${accent}">${tb.name}</b></p>
    ${coinHtml}
    ${overallHtml}
    <div class="rv-stats">
      <div class="rv-stat"><b>${fmtDur(r.dur)}</b><span>duration</span></div>
      <div class="rv-stat"><b>${r.setCount}</b><span>sets</span></div>
      <div class="rv-stat"><b>${r.exCount}</b><span>exercises</span></div>
      <div class="rv-stat"><b>${r.volume.toLocaleString()}</b><span>lb volume</span></div>
    </div>
    ${rankupHtml}
    ${exHtml}`;
  reviewModal.classList.remove("hidden");
  if (!silent && soundOn && (r.rankups.length || r.overallChanged)) { playRankUpSfx(); buzz([40, 60, 40]); }
}
document.getElementById("reviewDone").addEventListener("click", () => {
  reviewModal.classList.add("hidden");
  switchTab("home");
  // surface any badges earned this session AFTER the recap is dismissed, so the
  // light toast doesn't clash with rank-up celebrations / the review modal.
  checkAchievements();
});
function addExerciseToWorkout(exId) {
  if (!workout) startWorkout();
  const ex = exById(exId); if (!ex) return;
  const last = lastSetFor(ex.id);   // pre-fill weight + reps from last performance
  const lbs = last && last.lbs != null && last.lbs !== "" ? String(last.lbs) : "";
  const reps = last && last.reps != null && last.reps !== "" ? String(last.reps) : "";
  const sb = bests[ex.id] ? classify(bests[ex.id].mmr) : null;   // rank at entry, for finish-time celebration
  workout.exercises.push({ exId: ex.id, exName: ex.name, type: ex.type, rest: 90, restOn: true, collapsed: false, startBeast: sb ? sb.id : null, sets: [{ lbs, reps, added: "", done: false }] });
  saveWorkout(); renderWorkout();
}

// ---- per-set + per-exercise actions ----
function setField(i, j, field, val) { workout.exercises[i].sets[j][field] = val; saveWorkout(); }   // no re-render → keeps input focus
function addSet(i) {
  const ss = workout.exercises[i].sets; const last = ss[ss.length - 1];
  ss.push({ lbs: last ? last.lbs : "", reps: last ? last.reps : "", added: "", done: false });
  saveWorkout(); renderWorkout();
}
function removeExercise(i) {
  if (!confirm(`Remove ${workout.exercises[i].exName}?`)) return;
  workout.exercises.splice(i, 1); saveWorkout(); renderWorkout();
}
function toggleCollapse(i) { workout.exercises[i].collapsed = !workout.exercises[i].collapsed; saveWorkout(); renderWorkout(); }
function toggleRest(i) { workout.exercises[i].restOn = !workout.exercises[i].restOn; saveWorkout(); renderWorkout(); }
function editRest(i) {
  const v = prompt("Rest time in seconds:", workout.exercises[i].rest);
  if (v === null) return;
  const n = parseInt(v, 10); if (n >= 0) { workout.exercises[i].rest = n; saveWorkout(); renderWorkout(); }
}
function completeSet(i, j) {
  const exo = workout.exercises[i]; const ex = exById(exo.exId); const s = exo.sets[j];
  if (s.done) { s.done = false; saveWorkout(); renderWorkout(); return; }   // un-check (stays in history)
  const reps = parseInt(s.reps, 10) || 0;
  if (reps < 1) { alert("Enter reps first."); return; }
  let bodyweight = profile.bodyweight || 0, added = 0, weight = 0;
  if (ex.type === "bodyweight") {
    if (!bodyweight) { alert("Set your bodyweight up top first 🦎"); bwInput.focus(); return; }
    added = parseInt(s.lbs, 10) || 0;   // for bodyweight moves the LBS column = added weight
  } else {
    weight = parseInt(s.lbs, 10) || 0;
    if (!weight) { alert("Enter weight first."); return; }
  }
  const oneRM = estimate1RM(ex, { bodyweight, added, weight, reps });
  const mmr = mmrOf(oneRM, profile.bodyweight, ex);   // strength-standards rating (0–800)
  const beast = classify(mmr);                    // rank is MMR-driven (null bw -> null)
  s.done = true; s.oneRM = oneRM; s.beast = beast ? beast.id : null; s.added = added; s.mmr = mmr;
  const detail = ex.type === "bodyweight" ? `BW ${bodyweight}${added ? " + " + added : ""} × ${reps}` : `${weight} × ${reps}`;
  sets.unshift({ date: todayStr(), ts: Date.now(), exId: ex.id, exName: ex.name, detail, oneRM, beast: s.beast, mmr });
  const prev = bests[ex.id];
  const prevMmr = prev && typeof prev.mmr === "number" ? prev.mmr : -1;
  // best MMR drives the beast rank; track best oneRM independently for display.
  const bestMmr = Math.max(mmr ?? 0, prev && typeof prev.mmr === "number" ? prev.mmr : 0) || mmr;
  const bestBeast = classify(bestMmr);
  const prevBeast = prev && prev.beast ? byId(prev.beast) : null;   // null → was unranked (egg state)
  const rankedUp = !!bestBeast && tierOf(bestBeast.id) > (prevBeast ? tierOf(prevBeast.id) : 0);
  const newMmrPr = mmr != null && mmr > prevMmr;   // beat this lift's best MMR this set
  const bestOneRM = Math.max(oneRM, prev ? prev.oneRM : 0);
  if (!prev || bestMmr > (typeof prev.mmr === "number" ? prev.mmr : -1) || oneRM > prev.oneRM) {
    bests[ex.id] = { beast: bestBeast ? bestBeast.id : (prev ? prev.beast : null), oneRM: bestOneRM, date: todayStr(), mmr: bestMmr };
  }
  // record session events for the post-workout review (rank-ups + per-lift MMR PRs)
  if (workout) {
    workout.events = workout.events || [];
    if (rankedUp && bestBeast) workout.events.push({ kind: "rankup", exId: ex.id, exName: ex.name, from: prevBeast ? prevBeast.id : null, to: bestBeast.id });
    if (newMmrPr) workout.events.push({ kind: "pr", exId: ex.id, exName: ex.name, mmr });
  }
  // quest progress: every completed set counts; PRs and rank-ups feed their quests.
  trackDaily("sets"); trackLifetime("sets");
  if (newMmrPr) trackDaily("prs");
  if (rankedUp && bestBeast) trackLifetime("rankups");
  if (exo.restOn) workout.restEnd = Date.now() + exo.rest * 1000;
  // remember this performance so the lift's next set rows pre-fill (most recent
  // actual values: weight + reps for load lifts, added weight + reps for bw).
  lastSets[ex.id] = [{ lbs: s.lbs, reps: s.reps, added: added }];
  // NOTE: rank-ups are NOT celebrated mid-workout anymore — they're recorded in
  // workout.events above and played back one by one at finishWorkout().
  save(); saveWorkout(); renderWorkout(); tick();
  checkAchievements();   // a completed set may cross a set/rank/group threshold
}

// timers
let ticker = null;
function startTicker() { if (!ticker) ticker = setInterval(tick, 1000); tick(); }
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
function tick() {
  if (!workout) { stopTicker(); return; }
  const t = document.getElementById("sessTimer");
  if (t) t.textContent = clock(Math.floor((Date.now() - workout.start) / 1000));
  const rb = document.getElementById("restBanner"), rt = document.getElementById("restTime");
  if (rb) {
    if (workout.restEnd) {
      const left = Math.round((workout.restEnd - Date.now()) / 1000);
      if (left > 0) { rb.classList.remove("hidden"); if (rt) rt.textContent = clock(left); }
      else { workout.restEnd = null; saveWorkout(); rb.classList.add("hidden"); }
    } else rb.classList.add("hidden");
  }
}

function renderWorkout() {
  const start = document.getElementById("sessionStart"), active = document.getElementById("sessionActive");
  if (!workout) { start.classList.remove("hidden"); active.classList.add("hidden"); return; }
  start.classList.add("hidden"); active.classList.remove("hidden");
  const list = document.getElementById("exerciseList");
  list.innerHTML = "";
  workout.exercises.forEach((exo, i) => {
    const ex = exById(exo.exId);
    const rec = bests[exo.exId]; const rb = rec ? classify(rec.mmr) : null;
    const prev = lastSets[exo.exId] || [];

    // rank progress panel — progress is toward the next MMR band.
    let rankHtml;
    if (rb) {
      const ti = tierOf(rb.id); let pct = 100, nextTxt = "🐙 Apex beast — maxed out", label = "Next rank";
      if (ti < BEASTS.length) {
        const nb = BEASTS[ti]; const span = nb.mmrMin - rb.mmrMin;
        pct = Math.max(5, Math.min(100, Math.round(((rec.mmr - rb.mmrMin) / span) * 100)));
        // concrete how-to: the weight/reps needed on THIS lift to cross into nb.
        const tgt = nextRankTarget(ex, nb.mmrMin, profile.bodyweight);
        if (tgt && tgt.kind === "weight") nextTxt = `Hit ~${tgt.weight} lb → ${nb.emoji} ${nb.name}`;
        else if (tgt && tgt.kind === "reps") nextTxt = `Do ~${tgt.reps} reps → ${nb.emoji} ${nb.name}`;
        else nextTxt = `+${nb.mmrMin - rec.mmr} MMR → ${nb.emoji} ${nb.name}`;
        label = `+${nb.mmrMin - rec.mmr} MMR to next rank`;
      }
      rankHtml = `<div class="rankpanel" style="--c:${rb.color}">
        <div class="rank-badge">${rb.emoji}</div>
        <div class="rank-info">
          <div class="rank-next"><span>${label}</span><b>${nextTxt}</b></div>
          <div class="progress"><i style="width:${pct}%"></i></div>
          <div class="rank-name">${rb.name}</div>
        </div></div>`;
    } else {
      rankHtml = `<div class="rankpanel" style="--c:var(--line)">
        <div class="rank-badge">🥚</div>
        <div class="rank-info">
          <div class="rank-next"><span>Unranked</span><b>complete a set</b></div>
          <div class="progress"><i style="width:0%"></i></div>
          <div class="rank-name">Unranked</div>
        </div></div>`;
    }

    const prevTxt = (p) => p ? `${p.lbs || p.added || 0} × ${p.reps}` : "—";
    const rows = exo.sets.map((s, j) => `
      <div class="st-row ${s.done ? "done" : ""}">
        <span class="st-num">${j + 1}</span>
        <span class="st-prev">${prevTxt(prev[j])}</span>
        <input class="st-in st-lbs" data-i="${i}" data-j="${j}" type="number" inputmode="numeric" value="${s.lbs}" placeholder="${exo.type === "bodyweight" ? "+lbs" : "lbs"}" />
        <input class="st-in st-reps" data-i="${i}" data-j="${j}" type="number" inputmode="numeric" value="${s.reps}" placeholder="reps" />
        <button class="st-check ${s.done ? "done" : ""}" data-check="${i}-${j}">✓</button>
      </div>`).join("");

    const card = document.createElement("div");
    card.className = "exo" + (exo.collapsed ? " collapsed" : "");
    card.style.setProperty("--c", rb ? rb.color : "var(--line)");
    card.innerHTML = `
      <div class="exo-head">
        ${exThumb(ex)}
        <span class="exo-name">${exo.exName}</span>
        <button class="exo-btn" data-collapse="${i}">${exo.collapsed ? "▾" : "▴"}</button>
        <button class="exo-btn" data-del="${i}">✕</button>
      </div>
      <div class="exo-body">
        <div class="rest-row">
          <span class="rest-ic">⏱</span><span>Rest Timer</span>
          <b class="rest-val" data-restedit="${i}">${clock(exo.rest)} ✎</b>
          <button class="rest-sw ${exo.restOn ? "on" : ""}" data-resttoggle="${i}"></button>
        </div>
        ${rankHtml}
        <div class="settable">
          <div class="st-headrow"><span>SET</span><span>PREV</span><span>LBS</span><span>REPS</span><span></span></div>
          ${rows}
          <button class="addset-row" data-addset="${i}">＋ ADD SET</button>
        </div>
      </div>`;
    list.appendChild(card);
  });

  // wire up
  list.querySelectorAll("[data-collapse]").forEach((b) => b.addEventListener("click", () => toggleCollapse(+b.dataset.collapse)));
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeExercise(+b.dataset.del)));
  list.querySelectorAll("[data-resttoggle]").forEach((b) => b.addEventListener("click", () => toggleRest(+b.dataset.resttoggle)));
  list.querySelectorAll("[data-restedit]").forEach((b) => b.addEventListener("click", () => editRest(+b.dataset.restedit)));
  list.querySelectorAll("[data-addset]").forEach((b) => b.addEventListener("click", () => addSet(+b.dataset.addset)));
  list.querySelectorAll("[data-check]").forEach((b) => b.addEventListener("click", () => { const [i, j] = b.dataset.check.split("-").map(Number); completeSet(i, j); }));
  list.querySelectorAll(".st-lbs").forEach((inp) => inp.addEventListener("input", () => setField(+inp.dataset.i, +inp.dataset.j, "lbs", inp.value)));
  list.querySelectorAll(".st-reps").forEach((inp) => inp.addEventListener("input", () => setField(+inp.dataset.i, +inp.dataset.j, "reps", inp.value)));
}

// ===== food-chain reference cards =====
function renderChart() {
  const grid = document.getElementById("rankGrid");
  grid.innerHTML = "";
  BEASTS.forEach((b, i) => {
    const el = document.createElement("div");
    el.className = "card";
    el.style.setProperty("--c", b.color);
    el.style.animationDelay = `${i * 0.04}s`;
    el.innerHTML = `
      <div class="emoji">${b.emoji}</div>
      <div class="name">${b.name}</div>
      <div class="stats"><div><span>Rank</span><b>MMR ${beastRange(b)}</b></div></div>`;
    grid.appendChild(el);
  });
}

// ===== your ranks (best per exercise + progress to next tier) =====
function renderYourRanks() {
  const box = document.getElementById("yourRanks");
  const ranked = EXERCISES().filter((e) => bests[e.id]);
  if (!ranked.length) {
    box.innerHTML = `<p class="empty">Unranked. Log a set to earn your first rank. 🦎</p>`;
    return;
  }
  box.innerHTML = "";
  ranked
    .sort((a, b) => bests[b.id].oneRM - bests[a.id].oneRM)
    .forEach((e) => {
      const rec = bests[e.id];
      const b = classify(rec.mmr) || byId(rec.beast) || BEASTS[0];
      const ti = tierOf(b.id);
      let next = "", pct = 100;
      const hasMmr = typeof rec.mmr === "number";
      if (ti < BEASTS.length && hasMmr) {
        const nb = BEASTS[ti];               // next tier beast
        const span = nb.mmrMin - b.mmrMin;
        pct = Math.max(4, Math.min(100, Math.round(((rec.mmr - b.mmrMin) / span) * 100)));
        next = `<div class="rankrow-next">${nb.mmrMin - rec.mmr} MMR to ${nb.emoji} ${nb.name}</div>`;
      } else if (!hasMmr) {
        next = `<div class="rankrow-next">Set bodyweight to rank up</div>`;
      } else {
        next = `<div class="rankrow-next">🏆 Max tier reached</div>`;
      }
      const row = document.createElement("div");
      row.className = "rankrow";
      row.style.setProperty("--c", b.color);
      const mmrTxt = hasMmr ? rec.mmr.toLocaleString() : "—";
      row.innerHTML = `
        <div class="rankrow-top">
          <span class="rankrow-ex">${e.name}</span>
          <span class="rankrow-beast">${b.emoji} ${b.name} <small>· ~${rec.oneRM} lb</small></span>
        </div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="rankrow-foot">${next}<span class="rankrow-mmr">MMR ${mmrTxt}</span></div>`;
      box.appendChild(row);
    });
}

// ===== routines (reusable workout templates) =====
// A routine is { id, name, exercises:[{exId, sets, reps}] }. exId is resolved to the
// catalog at use time; a deleted exId is tolerated (shown as missing / skipped).
// editingRoutine holds a working copy while the build/edit sheet is open.
let editingRoutine = null;

function renderRoutines() {
  const box = document.getElementById("routineList");
  box.innerHTML = "";
  if (!routines.length) {
    box.innerHTML = `<p class="empty">No routines yet. Build one to start workouts with a tap. 🦎</p>`;
    return;
  }
  routines.forEach((r) => {
    const names = (r.exercises || []).map((re) => { const ex = exById(re.exId); return ex ? ex.name : "(removed)"; });
    const preview = names.slice(0, 4).join(" · ") + (names.length > 4 ? ` +${names.length - 4}` : "");
    const card = document.createElement("div");
    card.className = "routine-card";
    card.innerHTML = `
      <div class="rt-head">
        <span class="rt-name">${r.name}</span>
        <span class="rt-count">${names.length} exercise${names.length === 1 ? "" : "s"}</span>
      </div>
      <div class="rt-preview">${preview || "Empty routine"}</div>
      <div class="rt-actions">
        <button class="btn rt-start" data-start="${r.id}">▶ Start</button>
        <button class="btn ghost rt-edit" data-edit="${r.id}">Edit</button>
        <button class="btn ghost rt-del" data-del="${r.id}">Delete</button>
      </div>`;
    box.appendChild(card);
  });
  box.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", () => startRoutine(b.dataset.start)));
  box.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openRoutineEditor(b.dataset.edit)));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteRoutine(b.dataset.del)));
}

function startRoutine(id) {
  const r = routines.find((x) => x.id === id);
  if (!r) return;
  if (workout && !confirm("A workout is already in progress. Discard it and start this routine?")) return;
  startWorkout(r);
  switchTab("log");
}

function deleteRoutine(id) {
  const r = routines.find((x) => x.id === id);
  if (!r || !confirm(`Delete routine "${r.name}"?`)) return;
  routines = routines.filter((x) => x.id !== id);
  saveRoutines(); renderRoutines();
}

// ---- routine build/edit sheet ----
const routineEditor = document.getElementById("routineEditor");
function openRoutineEditor(id) {
  const existing = id ? routines.find((x) => x.id === id) : null;
  editingRoutine = existing
    ? { id: existing.id, name: existing.name, exercises: existing.exercises.map((e) => ({ ...e })) }
    : { id: "r_" + Date.now(), name: "", exercises: [] };
  document.getElementById("routineEditTitle").textContent = existing ? "Edit Routine" : "New Routine";
  document.getElementById("routineNameInput").value = editingRoutine.name;
  renderRoutineEditor();
  routineEditor.classList.remove("hidden");
}
function closeRoutineEditor() { routineEditor.classList.add("hidden"); editingRoutine = null; }

function renderRoutineEditor() {
  const list = document.getElementById("routineExList");
  list.innerHTML = "";
  if (!editingRoutine.exercises.length) {
    list.innerHTML = `<p class="empty">No exercises yet. Add some below.</p>`;
    return;
  }
  editingRoutine.exercises.forEach((re, i) => {
    const ex = exById(re.exId);
    const row = document.createElement("div");
    row.className = "rt-exrow";
    row.innerHTML = `
      ${exThumb(ex)}
      <div class="rt-ex-main">
        <span class="rt-ex-name">${ex ? ex.name : "(removed exercise)"}</span>
        <div class="rt-ex-targets">
          <label>sets <input type="number" inputmode="numeric" min="1" class="rt-t-sets" data-i="${i}" value="${re.sets ?? ""}" placeholder="3" /></label>
          <label>reps <input type="number" inputmode="numeric" min="1" class="rt-t-reps" data-i="${i}" value="${re.reps ?? ""}" placeholder="—" /></label>
        </div>
      </div>
      <div class="rt-ex-ord">
        <button class="exo-btn" data-up="${i}" ${i === 0 ? "disabled" : ""}>▴</button>
        <button class="exo-btn" data-down="${i}" ${i === editingRoutine.exercises.length - 1 ? "disabled" : ""}>▾</button>
        <button class="exo-btn" data-rm="${i}">✕</button>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll(".rt-t-sets").forEach((inp) => inp.addEventListener("input", () => { editingRoutine.exercises[+inp.dataset.i].sets = inp.value; }));
  list.querySelectorAll(".rt-t-reps").forEach((inp) => inp.addEventListener("input", () => { editingRoutine.exercises[+inp.dataset.i].reps = inp.value; }));
  list.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => moveRoutineEx(+b.dataset.up, -1)));
  list.querySelectorAll("[data-down]").forEach((b) => b.addEventListener("click", () => moveRoutineEx(+b.dataset.down, 1)));
  list.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { editingRoutine.exercises.splice(+b.dataset.rm, 1); renderRoutineEditor(); }));
}
function moveRoutineEx(i, dir) {
  const j = i + dir, ex = editingRoutine.exercises;
  if (j < 0 || j >= ex.length) return;
  [ex[i], ex[j]] = [ex[j], ex[i]];
  renderRoutineEditor();
}
// called by the shared exercise picker when in routine-pick mode
function addExerciseToRoutine(exId) {
  if (!editingRoutine) return;
  editingRoutine.exercises.push({ exId, sets: "", reps: "" });
  renderRoutineEditor();
}
function saveEditingRoutine() {
  const name = document.getElementById("routineNameInput").value.trim();
  if (!name) { alert("Name your routine first."); return; }
  if (!editingRoutine.exercises.length) { alert("Add at least one exercise."); return; }
  editingRoutine.name = name;
  const idx = routines.findIndex((x) => x.id === editingRoutine.id);
  if (idx >= 0) routines[idx] = editingRoutine; else routines.push(editingRoutine);
  saveRoutines(); closeRoutineEditor(); renderRoutines();
}
document.getElementById("routineNewBtn").addEventListener("click", () => openRoutineEditor(null));
document.getElementById("routineEditClose").addEventListener("click", closeRoutineEditor);
document.getElementById("routineSaveBtn").addEventListener("click", saveEditingRoutine);
document.getElementById("routineAddExBtn").addEventListener("click", () => openPicker("routine"));
routineEditor.addEventListener("click", (e) => { if (e.target === routineEditor) closeRoutineEditor(); });

// ===== economy: quests, earning, shop, inventory =====
// QUEST DEFINITIONS. Two kinds:
//   daily     — reset each calendar day; progress lives in quests.daily.<id>.
//   milestone — one-time lifetime achievements; progress in quests.lifetime.<id>.
// Each quest exposes goal (target), reward (coins), and a progress(d, l) fn that
// reads the relevant counter object. Claiming pays reward once (tracked separately
// for daily — keyed per-day — and milestones — keyed lifetime).
const MILESTONE_BEAST = "hypertrophy";   // "Reach Wired Wolf overall" target tier
const QUESTS = {
  daily: [
    { id: "d_workout", name: "Complete a workout today",     icon: "🏋️", goal: 1,  reward: 20, prog: (d) => d.workouts || 0 },
    { id: "d_sets",    name: "Log 15 sets today",            icon: "📋", goal: 15, reward: 25, prog: (d) => d.sets || 0 },
    { id: "d_pr",      name: "Set a new MMR PR today",        icon: "📈", goal: 1,  reward: 30, prog: (d) => d.prs || 0 },
  ],
  milestone: [
    { id: "m_first",   name: "Finish your first workout",     icon: "🥚", goal: 1,   reward: 50,  prog: (l) => l.workouts || 0 },
    { id: "m_sets100", name: "Log 100 total sets",            icon: "💯", goal: 100, reward: 100, prog: (l) => l.sets || 0 },
    { id: "m_rankups", name: "Rank up 10 times",              icon: "⬆️", goal: 10,  reward: 120, prog: (l) => l.rankups || 0 },
    { id: "m_streak7", name: "Hit a 7-day streak",            icon: "🔥", goal: 7,   reward: 150, prog: () => computeStreak() },
    { id: "m_beast",   name: `Reach ${byId(MILESTONE_BEAST).emoji} ${byId(MILESTONE_BEAST).name} overall`, icon: "👑", goal: 1, reward: 200,
      prog: () => { const ob = overallBeast(); return ob && tierOf(ob.id) >= tierOf(MILESTONE_BEAST) ? 1 : 0; } },
  ],
};
const SHOP = [
  { id: "restorer", name: "Streak Restorer", icon: "🩹", price: 120,
    desc: "Re-bridge yesterday's missed day so a broken streak continues. Used from your inventory.",
    invKey: "restorer" },
  { id: "freeze",   name: "Streak Freeze",   icon: "🧊", price: 80,
    desc: "Auto-protects your streak through one missed day. Consumed automatically when a day would break it.",
    invKey: "freeze" },
  { id: "booster",  name: "Coin Booster",    icon: "⚡", price: 60,
    desc: `Doubles the ${CUR} earned from your next finished workout. Arm it from your inventory.`,
    invKey: "booster" },
];

// ===== COSMETICS: a Scales sink with four equip slots =======================
// Owned + equipped state lives in profile.cosmetics (reptilift_profile → SYNC_KEYS,
// so it cloud-syncs). Each slot has a "" default (= current/no cosmetic look).
//   theme     — alternate palette/background for the shareable rank card (owner-only).
//   frame     — decorative ring around the avatar (profile + leaderboard; PUBLISHED).
//   nameColor — color/gradient on the display name (profile + leaderboard; PUBLISHED).
//   border    — border/glow style for the profile header card (owner-only).
// Prices are aspirational (a real sink). Each item carries the visual data it needs:
//   theme: { bg:[topHex,botHex], accent, wordmark } drives drawRankCard.
//   frame: { ring, glow } CSS colors (used to build a ring via box-shadow/border).
//   nameColor: { color } solid, or { gradient:[a,b] } for a text gradient.
//   border: { color, glow } for the profile header card frame.
const COSMETICS = {
  theme: [
    { id: "themeMolten", name: "Molten",  price: 350, swatch: "linear-gradient(135deg,#ff5a1f,#7a1502)",
      bg: ["#2a0d06", "#120402"], accent: "#ff7a33", wordmark: "#ffb37a" },
    { id: "themeToxic",  name: "Toxic",   price: 350, swatch: "linear-gradient(135deg,#7CFF4F,#0a3d12)",
      bg: ["#0a2410", "#04130a"], accent: "#8dff52", wordmark: "#c6ff9e" },
    { id: "themeRoyal",  name: "Royal",   price: 500, swatch: "linear-gradient(135deg,#a06bff,#f2c14e)",
      bg: ["#1a0e33", "#0a0518"], accent: "#b288ff", wordmark: "#f2c14e" },
    { id: "themeCarbon", name: "Carbon",  price: 250, swatch: "linear-gradient(135deg,#3a3f44,#0c0e0d)",
      bg: ["#1a1d1f", "#0a0b0c"], accent: "#c9ced4", wordmark: "#eaf5ee" },
    { id: "themeAbyss",  name: "Abyss",   price: 450, swatch: "linear-gradient(135deg,#2eb6ff,#04203a)",
      bg: ["#06223a", "#020c16"], accent: "#39c0ff", wordmark: "#9fe3ff" },
  ],
  frame: [
    { id: "frameGold",  name: "Gold Ring",   price: 200, ring: "#f2c14e", glow: "#f2c14e" },
    { id: "frameFlame", name: "Flame Ring",  price: 300, ring: "#ff7a33", glow: "#ff4d1f" },
    { id: "frameNeon",  name: "Neon Ring",   price: 300, ring: "#39c0ff", glow: "#2eb6ff" },
    { id: "frameScale", name: "Beast Scale", price: 400, ring: "#8dff52", glow: "#5fd23a" },
    { id: "framePlasma",name: "Plasma Ring", price: 500, ring: "#b288ff", glow: "#a06bff" },
  ],
  nameColor: [
    { id: "nameGold",   name: "Gold",        price: 150, color: "#f2c14e" },
    { id: "nameMolten", name: "Molten",      price: 250, gradient: ["#ff9a3d", "#ff3d2e"] },
    { id: "nameToxic",  name: "Toxic",       price: 250, color: "#8dff52" },
    { id: "nameRoyal",  name: "Royal",       price: 300, gradient: ["#b288ff", "#f2c14e"] },
    { id: "nameIce",    name: "Ice",         price: 300, gradient: ["#9fe3ff", "#39c0ff"] },
  ],
  border: [
    { id: "borderGold",   name: "Gold Glow",   price: 250, color: "#f2c14e", glow: "#f2c14e" },
    { id: "borderFlame",  name: "Flame Glow",  price: 350, color: "#ff7a33", glow: "#ff4d1f" },
    { id: "borderNeon",   name: "Neon Glow",   price: 350, color: "#39c0ff", glow: "#2eb6ff" },
    { id: "borderRoyal",  name: "Royal Glow",  price: 450, color: "#b288ff", glow: "#a06bff" },
  ],
};
const COSMETIC_SLOTS = [
  { slot: "theme",     label: "Rank-Card Theme", hint: "Recolors your shareable rank card" },
  { slot: "frame",     label: "Avatar Frame",    hint: "A ring shown on your avatar & leaderboard row" },
  { slot: "nameColor", label: "Name Color",      hint: "Tints your display name everywhere" },
  { slot: "border",    label: "Profile Border",  hint: "A glow around your profile header" },
];
// flat lookup: itemId → { slot, ...item }. Built once; guarded so a bad shape is skipped.
const COSMETIC_BY_ID = (() => {
  const m = {};
  try {
    Object.keys(COSMETICS).forEach((slot) => {
      (COSMETICS[slot] || []).forEach((it) => { if (it && it.id) m[it.id] = Object.assign({ slot }, it); });
    });
  } catch (e) {}
  return m;
})();
// is an item owned? (guarded)
function cosmeticOwned(id) {
  try { return !!(profile.cosmetics && profile.cosmetics.owned && profile.cosmetics.owned[id]); }
  catch (e) { return false; }
}
// the equipped item object for a slot, or null. Falls back to null if the equipped id
// is no longer owned/known (so a removed cosmetic cleanly reverts to default).
function equippedCosmetic(slot) {
  try {
    const id = profile.cosmetics && profile.cosmetics.equipped && profile.cosmetics.equipped[slot];
    if (!id || !cosmeticOwned(id)) return null;
    const it = COSMETIC_BY_ID[id];
    return it && it.slot === slot ? it : null;
  } catch (e) { return null; }
}
// equip (or, with id="" / unowned, unequip) a slot. Persists + re-publishes social bits.
function equipCosmetic(slot, id) {
  try {
    if (!profile.cosmetics.equipped || typeof profile.cosmetics.equipped !== "object") profile.cosmetics.equipped = {};
    profile.cosmetics.equipped[slot] = (id && cosmeticOwned(id) && COSMETIC_BY_ID[id] && COSMETIC_BY_ID[id].slot === slot) ? id : "";
    save();
    try { if (typeof publishPublicProfile === "function") publishPublicProfile(); } catch (e) {}
  } catch (e) {}
}
// CSS for an avatar frame given a frame item (or null). Returns "" for none.
function frameStyleCss(fr) {
  if (!fr || !fr.ring) return "";
  return `box-shadow:0 0 0 3px ${fr.ring}, 0 0 16px ${hexA(fr.glow || fr.ring, 0.7)};border-color:${fr.ring} !important;`;
}
// inline style for a display name given a nameColor item (or null). Returns "".
function nameColorCss(nc) {
  if (!nc) return "";
  if (nc.gradient && nc.gradient.length === 2) {
    return `background:linear-gradient(90deg,${nc.gradient[0]},${nc.gradient[1]});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:${nc.gradient[1]};`;
  }
  if (nc.color) return `color:${nc.color};`;
  return "";
}
// Resolve a published row's small cosmetics blob ({frame, nameColor}) into objects.
// Guarded so null/legacy rows just yield {}.
function rowCosmetics(p) {
  const out = { frame: null, nameColor: null };
  try {
    const c = p && p.cosmetics;
    if (c && typeof c === "object") {
      if (c.frame && COSMETIC_BY_ID[c.frame] && COSMETIC_BY_ID[c.frame].slot === "frame") out.frame = COSMETIC_BY_ID[c.frame];
      if (c.nameColor && COSMETIC_BY_ID[c.nameColor] && COSMETIC_BY_ID[c.nameColor].slot === "nameColor") out.nameColor = COSMETIC_BY_ID[c.nameColor];
    }
  } catch (e) {}
  return out;
}

// roll the daily counters over when the calendar day changes (browser Date).
function rolloverDaily() {
  const t = todayStr();
  if (quests.daily.date !== t) {
    quests.daily = { date: t, workouts: 0, sets: 0, prs: 0, claimed: {} };
    saveEconomy();
  }
  if (!quests.daily.claimed) quests.daily.claimed = {};
}
// bump a counter and persist; used to wire quest progress to real events.
function trackDaily(key, n = 1) { rolloverDaily(); quests.daily[key] = (quests.daily[key] || 0) + n; saveEconomy(); }
function trackLifetime(key, n = 1) { quests.lifetime[key] = (quests.lifetime[key] || 0) + n; saveEconomy(); }

// award coins for a finished session. Surfaced in the review as "+N Scales".
// base + per completed set + per rank-up + a bigger bonus if overall rank rose.
// Coin Booster (if armed) doubles the whole payout and is consumed here.
// Idempotent per session: stamps the workout's start id into r so re-showing the
// review doesn't re-pay (finishWorkout passes the already-built review object).
function awardWorkoutCoins(r) {
  if (!r || r.empty || r.coins != null) return r ? (r.coins || 0) : 0;
  let coins = 10;                                  // base
  coins += 2 * r.setCount;                         // +2 / completed set
  coins += 25 * r.rankups.length;                  // +25 / rank-up
  if (r.overallChanged) coins += 50;               // +50 new overall rank
  let boosted = false;
  if (inventory.boosterArmed) { coins *= 2; boosted = true; inventory.boosterArmed = false; }
  addCoins(coins);
  saveEconomy();
  r.coins = coins; r.boosted = boosted;
  return coins;
}

// ---- nav into shop/quests ----
function renderShop() {
  refreshWallet();
  const box = document.getElementById("shopList");
  box.innerHTML = "";
  SHOP.forEach((item) => {
    const owned = inventory[item.invKey] || 0;
    const card = document.createElement("div");
    card.className = "shop-item";
    card.innerHTML = `
      <div class="shop-ic">${item.icon}</div>
      <div class="shop-main">
        <div class="shop-name">${item.name} ${owned ? `<span class="shop-owned">×${owned} owned</span>` : ""}</div>
        <div class="shop-desc">${item.desc}</div>
      </div>
      <button class="btn shop-buy" data-buy="${item.id}">${COIN} ${item.price}</button>`;
    box.appendChild(card);
  });
  box.querySelectorAll("[data-buy]").forEach((b) => b.addEventListener("click", () => buyItem(b.dataset.buy)));
  renderCosmeticShop();
  renderInventory();
}
function buyItem(id) {
  const item = SHOP.find((x) => x.id === id); if (!item) return;
  if (wallet.balance < item.price) { alert(`Not enough ${CUR}. You need ${item.price - wallet.balance} more ${COIN}.`); return; }
  addCoins(-item.price);
  inventory[item.invKey] = (inventory[item.invKey] || 0) + 1;
  saveEconomy();
  if (soundOn) blip();
  renderShop();
}

// small visual preview for a cosmetic shop card (matches its slot).
function cosmeticPreview(c) {
  if (c.slot === "theme")  return `<span class="cos-prev cos-prev-theme" style="background:${c.swatch}"></span>`;
  if (c.slot === "frame")  return `<span class="cos-prev cos-prev-frame" style="${frameStyleCss(c)}">🦎</span>`;
  if (c.slot === "border") return `<span class="cos-prev cos-prev-border" style="border-color:${c.color};box-shadow:0 0 14px ${hexA(c.glow || c.color, 0.8)}"></span>`;
  if (c.slot === "nameColor") return `<span class="cos-prev cos-prev-name" style="${nameColorCss(c)}">Name</span>`;
  return `<span class="cos-prev"></span>`;
}
// Cosmetics storefront: one labeled group per slot, each item shows a preview, name,
// and Buy/Owned. Buying deducts Scales and adds to owned; blocked (clear msg) if short.
function renderCosmeticShop() {
  const box = document.getElementById("cosmeticList");
  if (!box) return;
  box.innerHTML = "";
  COSMETIC_SLOTS.forEach((s) => {
    const grp = document.createElement("div");
    grp.className = "cos-group";
    const items = (COSMETICS[s.slot] || []).map((c) => {
      const owned = cosmeticOwned(c.id);
      const equipped = (profile.cosmetics.equipped[s.slot] === c.id) && owned;
      const btn = owned
        ? (equipped ? `<span class="cos-eq">✓ Equipped</span>` : `<button class="btn ghost cos-act" data-cos-equip="${c.id}">Equip</button>`)
        : `<button class="btn cos-act" data-cos-buy="${c.id}">${COIN} ${c.price}</button>`;
      return `<div class="cos-item${equipped ? " on" : ""}">
        ${cosmeticPreview(c)}
        <div class="cos-info"><div class="cos-name">${c.name}</div>
          <div class="cos-tag">${owned ? "Owned" : "Locked"}</div></div>
        ${btn}</div>`;
    }).join("");
    grp.innerHTML = `<div class="cos-grouptitle">${s.label}<span>${s.hint}</span></div>
      <div class="cos-items">${items}</div>`;
    box.appendChild(grp);
  });
  box.querySelectorAll("[data-cos-buy]").forEach((b) => b.addEventListener("click", () => buyCosmetic(b.dataset.cosBuy)));
  box.querySelectorAll("[data-cos-equip]").forEach((b) => b.addEventListener("click", () => {
    const c = COSMETIC_BY_ID[b.dataset.cosEquip]; if (!c) return;
    equipCosmetic(c.slot, c.id);
    if (soundOn) blip();
    renderShop();
    try { const pp = document.getElementById("profile-page"); if (typeof renderProfile === "function" && pp && pp.classList.contains("active")) renderProfile(); } catch (e) {}
  }));
}
// buy a cosmetic: guard unknown/owned, deduct Scales (clear message if short), add to
// owned, auto-equip it for instant gratification, persist, re-publish social bits.
function buyCosmetic(id) {
  const c = COSMETIC_BY_ID[id]; if (!c) return;
  if (cosmeticOwned(id)) return;
  if (wallet.balance < c.price) { alert(`Not enough ${CUR}. You need ${c.price - wallet.balance} more ${COIN}.`); return; }
  addCoins(-c.price);
  profile.cosmetics.owned[id] = 1;
  profile.cosmetics.equipped[c.slot] = id;   // auto-equip the fresh purchase
  saveEconomy();                              // persist the wallet/lifetime change
  save();                                     // persist profile cosmetics (cloud auto-push)
  try { if (typeof publishPublicProfile === "function") publishPublicProfile(); } catch (e) {}
  if (soundOn) blip();
  renderShop();
}

function renderInventory() {
  const box = document.getElementById("inventoryList");
  if (!box) return;
  const items = [
    { key: "restorer", icon: "🩹", name: "Streak Restorer", action: "Use", hint: "Bridges yesterday to save your streak" },
    { key: "freeze",   icon: "🧊", name: "Streak Freeze",   action: null,  hint: "Auto-used on a missed day" },
    { key: "booster",  icon: "⚡", name: "Coin Booster",    action: "Arm", hint: "Doubles your next workout payout" },
  ];
  const owned = items.filter((it) => (inventory[it.key] || 0) > 0 || (it.key === "booster" && inventory.boosterArmed));
  if (!owned.length) { box.innerHTML = `<p class="empty">Empty. Buy items in the Shop to stock up. 🦎</p>`; return; }
  box.innerHTML = "";
  owned.forEach((it) => {
    const count = inventory[it.key] || 0;
    const armed = it.key === "booster" && inventory.boosterArmed;
    const row = document.createElement("div");
    row.className = "inv-item";
    let btn = "";
    if (it.key === "booster") {
      btn = armed
        ? `<span class="inv-armed">⚡ Armed</span>`
        : (count > 0 ? `<button class="btn ghost inv-use" data-use="booster">Arm</button>` : "");
    } else if (it.action && count > 0) {
      btn = `<button class="btn ghost inv-use" data-use="${it.key}">${it.action}</button>`;
    }
    row.innerHTML = `
      <span class="inv-ic">${it.icon}</span>
      <div class="inv-main"><div class="inv-name">${it.name} <b>×${count}</b></div><div class="inv-hint">${it.hint}</div></div>
      ${btn}`;
    box.appendChild(row);
  });
  box.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", () => useItem(b.dataset.use)));
}
function useItem(key) {
  if (key === "booster") {
    if (!(inventory.booster > 0) || inventory.boosterArmed) return;
    inventory.booster--; inventory.boosterArmed = true; saveEconomy();
    if (soundOn) blip();
    renderShop();
    return;
  }
  if (key === "restorer") {
    if (!(inventory.restorer > 0)) return;
    const days = streakDays();
    const yest = fmtDate(new Date(Date.now() - 864e5));
    if (days.has(yest) || days.has(todayStr())) { alert("Your streak isn't broken — no need to restore it yet. 🦎"); return; }
    inventory.restorer--; streakx.bridges.push(yest); saveEconomy();
    if (soundOn) blip();
    alert("Streak restored! Log a workout today to keep it alive. 🦎");
    renderShop(); renderHome();
    return;
  }
}

// shared quest-row markup. Used by the Quests page AND the menu daily widget so
// the two stay in sync (same progress bar / claim button / claimed state).
function buildQuestRow(q, prog, claimed) {
  const cur = Math.min(prog, q.goal), done = prog >= q.goal;
  const pct = Math.max(0, Math.min(100, Math.round((cur / q.goal) * 100)));
  const state = claimed ? "claimed" : (done ? "ready" : "");
  const btn = claimed
    ? `<span class="q-claimed">✓ Claimed</span>`
    : (done ? `<button class="btn q-claim" data-claim="${q.id}">Claim ${COIN} ${q.reward}</button>`
            : `<span class="q-reward">${COIN} ${q.reward}</span>`);
  return `<div class="quest ${state}">
    <div class="q-ic">${q.icon}</div>
    <div class="q-main">
      <div class="q-name">${q.name}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="q-prog">${cur.toLocaleString()} / ${q.goal.toLocaleString()}</div>
    </div>
    ${btn}</div>`;
}

function renderQuests() {
  rolloverDaily(); refreshWallet();
  const dBox = document.getElementById("dailyQuests"), mBox = document.getElementById("milestoneQuests");
  dBox.innerHTML = QUESTS.daily.map((q) => buildQuestRow(q, q.prog(quests.daily), !!quests.daily.claimed[q.id])).join("");
  mBox.innerHTML = QUESTS.milestone.map((q) => buildQuestRow(q, q.prog(quests.lifetime), !!quests.claimed[q.id])).join("");
  document.querySelectorAll("#quests [data-claim]").forEach((b) => b.addEventListener("click", () => claimQuest(b.dataset.claim)));
}
function claimQuest(id) {
  let q = QUESTS.daily.find((x) => x.id === id), daily = true;
  if (!q) { q = QUESTS.milestone.find((x) => x.id === id); daily = false; }
  if (!q) return;
  const prog = daily ? q.prog(quests.daily) : q.prog(quests.lifetime);
  const already = daily ? quests.daily.claimed[id] : quests.claimed[id];
  if (already || prog < q.goal) return;            // guard double-claim / incomplete
  addCoins(q.reward);
  if (daily) quests.daily.claimed[id] = true; else quests.claimed[id] = true;
  quests.lifetime.claims = (quests.lifetime.claims || 0) + 1;   // total quests claimed (Quest Hunter)
  saveEconomy();
  checkAchievements();   // claiming/earning Scales may unlock Quest Hunter / High Roller
  if (soundOn) { playRankUpSfx(); buzz([30, 40, 30]); }
  // refresh whichever views exist — the Quests page and the menu daily widget
  // share claim logic, so both must reflect the payout / claimed state.
  renderQuests();
  renderHomeQuests();
}

// menu daily-quests widget: an at-a-glance view of just TODAY'S daily quests,
// reusing the shared row builder + claim logic so it stays in sync with the
// Quests page. Reflects rolloverDaily and re-renders on home render / claim.
function renderHomeQuests() {
  const box = document.getElementById("homeQuests");
  if (!box) return;
  rolloverDaily();
  box.innerHTML = QUESTS.daily
    .map((q) => buildQuestRow(q, q.prog(quests.daily), !!quests.daily.claimed[q.id]))
    .join("");
  box.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", () => claimQuest(b.dataset.claim)));
}

// ===== achievements (permanent milestone badges) =====
// A static catalog of one-time badges. Each: id, name, desc, icon, and a pure
// check(ctx) predicate over a snapshot of game state (achievementCtx()). Earned
// state lives in `achievements.earned` (reptilift_achievements, in SYNC_KEYS);
// once earned, always earned. checkAchievements() runs at the moments state
// changes (init, set complete, finish, quest claim, coin earn) and toasts the
// newly-unlocked ones. Checks are read-only and guarded so they never throw.
const MUSCLE_GROUPS = ["Chest", "Back", "Shoulders", "Legs", "Arms", "Core"];
const APEX_OVERALL_TIER = tierOf("rhino");   // "Perfectly Balanced": Raging Rhino+ overall

// Build a read-only snapshot of everything the checks need. Cheap; called per check pass.
function achievementCtx() {
  // muscle groups trained (any logged set whose exercise has that group)
  const groupsTrained = new Set();
  sets.forEach((s) => { const ex = exById(s.exId); if (ex && ex.group) groupsTrained.add(ex.group); });
  // top per-lift beast tier across all bests + whether each big-three lift is ranked
  let topLiftTier = 0;
  const ranked = {};
  for (const id in bests) {
    const rec = bests[id];
    const b = rec && typeof rec.mmr === "number" ? classify(rec.mmr) : (rec && rec.beast ? byId(rec.beast) : null);
    if (b) { ranked[id] = true; topLiftTier = Math.max(topLiftTier, tierOf(b.id)); }
  }
  const ob = overallBeast();
  // biggest single-workout volume ever (Σ load×reps per finished session)
  let bestWorkoutVolume = 0;
  const vol = volumeSeries();   // [{label,value}] one entry per day with volume
  vol.forEach((p) => { if (p.value > bestWorkoutVolume) bestWorkoutVolume = p.value; });
  return {
    sets, workouts, ranked, groupsTrained, topLiftTier,
    overallTier: ob ? tierOf(ob.id) : 0,
    streak: computeStreak(),
    bestWorkoutVolume,
    questClaims: (quests.lifetime && quests.lifetime.claims) || 0,
    rankups: (quests.lifetime && quests.lifetime.rankups) || 0,
    coinsEarned: (quests.lifetime && quests.lifetime.coins) || 0,
    balance: wallet.balance,
    rankedCount: Object.keys(ranked).length,
  };
}

const ACHIEVEMENTS = [
  { id: "a_firstrep",  icon: "🥚", name: "First Rep",          desc: "Finish your very first workout.",
    check: (c) => c.workouts.length >= 1 },
  { id: "a_hatchling", icon: "🐣", name: "Hatchling",          desc: "Earn your first rank on any lift.",
    check: (c) => c.rankedCount >= 1 },
  { id: "a_bigthree",  icon: "🏋️", name: "The Big Three",      desc: "Rank bench, squat AND deadlift.",
    check: (c) => c.ranked.bench && c.ranked.squat && c.ranked.deadlift },
  { id: "a_jack",      icon: "🧩", name: "Jacked of All Trades", desc: "Train every muscle group at least once.",
    check: (c) => MUSCLE_GROUPS.every((g) => c.groupsTrained.has(g)) },
  { id: "a_century",   icon: "💯", name: "Century",            desc: "Log 100 total sets.",
    check: (c) => c.sets.length >= 100 },
  { id: "a_500sets",   icon: "📚", name: "Set Machine",        desc: "Log 500 total sets.",
    check: (c) => c.sets.length >= 500 },
  { id: "a_veteran",   icon: "🎖️", name: "Iron Veteran",       desc: "Complete 50 workouts.",
    check: (c) => c.workouts.length >= 50 },
  { id: "a_week",      icon: "🔥", name: "Week Warrior",       desc: "Hit a 7-day streak.",
    check: (c) => c.streak >= 7 },
  { id: "a_unbreak",   icon: "🛡️", name: "Unbreakable",        desc: "Hit a 30-day streak.",
    check: (c) => c.streak >= 30 },
  { id: "a_climbing",  icon: "🧗", name: "Climbing",           desc: "Rank up 25 times in total.",
    check: (c) => c.rankups >= 25 },
  { id: "a_oneton",    icon: "🪨", name: "One Ton",            desc: "Move 2,000+ lb of volume in a single workout.",
    check: (c) => c.bestWorkoutVolume >= 2000 },
  { id: "a_apexlift",  icon: "🐙", name: "Apex Predator",      desc: "Reach Optimal Octopus on any lift.",
    check: (c) => c.topLiftTier >= tierOf("octopus") },
  { id: "a_balanced",  icon: "⚖️", name: "Perfectly Balanced", desc: `Reach ${byId("rhino").emoji} ${byId("rhino").name} or better overall.`,
    check: (c) => c.overallTier >= APEX_OVERALL_TIER },
  { id: "a_apexbeast", icon: "👑", name: "Apex Beast",         desc: "Reach Optimal Octopus OVERALL.",
    check: (c) => c.overallTier >= tierOf("octopus") },
  { id: "a_quests",    icon: "🎯", name: "Quest Hunter",       desc: "Claim 20 quests in total.",
    check: (c) => c.questClaims >= 20 },
  { id: "a_highroller",icon: "🦎", name: "High Roller",        desc: "Earn 1,000 Scales over your lifetime.",
    check: (c) => c.coinsEarned >= 1000 },
  { id: "a_collector", icon: "🏆", name: "Collector",          desc: "Rank 10 different lifts.",
    check: (c) => c.rankedCount >= 10 },
];

// Evaluate every un-earned achievement against current state; stamp newly-earned
// ones with today's date and toast them. Cheap, fully guarded — never throws and
// never blocks the caller. Returns the list of newly-earned achievement objects.
function checkAchievements() {
  try {
    const ctx = achievementCtx();
    const fresh = [];
    ACHIEVEMENTS.forEach((a) => {
      if (achievements.earned[a.id]) return;            // already earned — leave it
      let got = false;
      try { got = !!a.check(ctx); } catch (e) { got = false; }
      if (got) { achievements.earned[a.id] = todayStr(); fresh.push(a); }
    });
    if (fresh.length) {
      saveAchievements();
      queueAchievementToast(fresh);
    }
    return fresh;
  } catch (e) { return []; }
}

// ---- unlock toast (light celebratory popup, NOT the big rank-up animation) ----
// A small badge popup appears bottom-center for ~2.4s, dismissible by tap. Multiple
// simultaneous unlocks are combined into one toast (with a count). Queued so a burst
// (e.g. a workout finish) shows one at a time without stacking.
let achToastQueue = [];
let achToastShowing = false;
function queueAchievementToast(list) {
  if (!list || !list.length) return;
  achToastQueue.push(list.slice());
  if (!achToastShowing) showNextAchievementToast();
}
function showNextAchievementToast() {
  const group = achToastQueue.shift();
  if (!group) { achToastShowing = false; return; }
  achToastShowing = true;
  let el = document.getElementById("achToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "achToast";
    el.className = "achtoast";
    document.body.appendChild(el);
  }
  const head = group[0];
  const more = group.length - 1;
  el.innerHTML = `
    <span class="at-ic">${head.icon}</span>
    <span class="at-main">
      <span class="at-tag">🏅 Achievement unlocked</span>
      <span class="at-name">${escapeHtml(head.name)}${more > 0 ? ` <small>+${more} more</small>` : ""}</span>
    </span>`;
  // restart the entrance animation cleanly even on back-to-back toasts
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  if (soundOn) { try { playRankUpSfx(); } catch (e) {} buzz([20, 40, 20]); }
  let closed = false, timer = null;
  const close = () => {
    if (closed) return; closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    el.classList.remove("show");
    el.removeEventListener("click", close);
    setTimeout(showNextAchievementToast, 360);   // let it slide out before the next
  };
  el.addEventListener("click", close);
  timer = setTimeout(close, 2400);
}

// ---- achievements display (Profile preview + dedicated page) ----
function earnedCount() { return ACHIEVEMENTS.filter((a) => achievements.earned[a.id]).length; }

// one badge tile (earned = full color, locked = dimmed). Earned tiles expose the
// date earned via title (tap/hover). Locked tiles still show name + desc to chase.
function achTileHtml(a) {
  const date = achievements.earned[a.id];
  const earned = !!date;
  const when = earned ? `Earned ${prettyDate(date)}` : "Locked";
  return `<div class="achtile ${earned ? "earned" : "locked"}" title="${escapeHtml(when)}">
    <span class="ach-ic">${a.icon}</span>
    <span class="ach-name">${escapeHtml(a.name)}</span>
    <span class="ach-desc">${escapeHtml(a.desc)}</span>
    <span class="ach-when">${earned ? escapeHtml(when) : "🔒 Locked"}</span>
  </div>`;
}

// full grid on the dedicated #achievements-page (earned first, then locked).
function renderAchievements() {
  const grid = document.getElementById("achGrid");
  if (!grid) return;
  const count = document.getElementById("achCount");
  if (count) count.textContent = `${earnedCount()} / ${ACHIEVEMENTS.length} unlocked`;
  const earned = ACHIEVEMENTS.filter((a) => achievements.earned[a.id]);
  const locked = ACHIEVEMENTS.filter((a) => !achievements.earned[a.id]);
  grid.innerHTML = [...earned, ...locked].map(achTileHtml).join("");
}

// compact preview on the Profile page: count + the first few earned badges (or the
// next ones to chase if none earned yet). Tapping opens the full page.
function renderProfileAchievements() {
  const box = document.getElementById("profileAch");
  if (!box) return;
  const got = earnedCount();
  const earned = ACHIEVEMENTS.filter((a) => achievements.earned[a.id]);
  const preview = (earned.length ? earned : ACHIEVEMENTS).slice(0, 4);
  box.innerHTML = `
    <button class="pa-head" data-go="achievements-page" type="button">
      <span class="pa-title">🏅 Achievements</span>
      <span class="pa-count">${got} / ${ACHIEVEMENTS.length}</span>
      <span class="pl-arrow">›</span>
    </button>
    <div class="pa-row">${preview.map((a) => {
      const isEarned = !!achievements.earned[a.id];
      return `<span class="pa-badge ${isEarned ? "earned" : "locked"}" title="${escapeHtml(a.name)}">${a.icon}</span>`;
    }).join("")}</div>`;
  const head = box.querySelector(".pa-head");
  if (head) head.addEventListener("click", () => switchTab("achievements-page"));
}

// ===== home dashboard =====
function renderHome() {
  const hero = document.getElementById("rankHero");
  const b = overallBeast();
  const mmr = overallMMR();
  const mmrBadge = `<div class="rh-mmr"><span>MMR</span><b>${mmr != null ? mmr.toLocaleString() : "—"}</b></div>`;
  if (!b) {
    hero.style.setProperty("--c", "#5b6168");
    hero.innerHTML = `
      <div class="rh-label">Your rank</div>
      <div class="rh-emoji">🥚</div>
      <div class="rh-name">Unranked</div>
      <div class="rh-sub">Log a workout to earn your first beast.</div>
      ${mmrBadge}`;
  } else {
    hero.style.setProperty("--c", b.color);
    hero.innerHTML = `
      <div class="rh-label">Your rank · MMR ${beastRange(b)}</div>
      <div class="rh-emoji">${b.emoji}</div>
      <div class="rh-name">${b.name}</div>
      <div class="rh-sub">${mmr != null ? "Averaged across all your ranked lifts" : "Set your bodyweight to unlock MMR"}</div>
      ${mmrBadge}`;
  }
  const top = todaySets().reduce((m, s) => Math.max(m, s.oneRM), 0);
  document.getElementById("statStreak").textContent = computeStreak();
  document.getElementById("statTop").textContent = top ? top.toLocaleString() : "0";
  document.getElementById("statExers").textContent = Object.keys(bests).length;
  renderHomeQuests();
  refreshAvatars();
}

// ===== profile =====
// All profile data lives in the shared `profile` object (reptilift_profile), which
// is already in SYNC_KEYS — so saving it auto-pushes to the cloud and applyCloud()
// brings the avatar/name/bio down on other devices.

// avatar markup: the user's picture if set, else the 🦎 fallback. `cls` is added
// to the wrapping element so each caller can size/style it.
function avatarInner() {
  return profile.avatar
    ? `<img src="${profile.avatar}" alt="" />`
    : "🦎";
}
// keep every on-screen avatar (top chip + menu link) in sync with the stored one.
function refreshAvatars() {
  const chip = document.getElementById("acctChipAvatar");
  if (chip) chip.innerHTML = avatarInner();
  const menuAv = document.getElementById("menuProfileAvatar");
  if (menuAv) menuAv.innerHTML = avatarInner();
  const menuName = document.getElementById("menuProfileName");
  if (menuName) menuName.textContent = profile.name ? profile.name : "Your Profile";
}

// earliest dated activity (workout or set) → a "Member since" string, or null.
function memberSince() {
  let earliest = null;
  sets.forEach((s) => { if (s.date && (!earliest || s.date < earliest)) earliest = s.date; });
  workouts.forEach((w) => { if (w.date && (!earliest || w.date < earliest)) earliest = w.date; });
  if (!earliest) return null;
  const [y, m, d] = earliest.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// the highest-MMR ranked exercise → { name, beast } or null.
function topLift() {
  let best = null;
  for (const id in bests) {
    const rec = bests[id];
    if (!rec || typeof rec.mmr !== "number") continue;
    if (!best || rec.mmr > best.mmr) best = { id, mmr: rec.mmr };
  }
  if (!best) return null;
  const ex = exById(best.id);
  return { name: ex ? ex.name : best.id, beast: classify(best.mmr) };
}

// Resolve the stored favorite into a display object, tolerating a missing/stale id.
// Returns null when unset or the id no longer matches a catalog exercise. When the
// favorite has a recorded best, includes its beast + MMR for the read-only display.
function favoriteLift() {
  const id = profile.favoriteExercise;
  if (!id) return null;
  const ex = exById(id);
  if (!ex) return null;                          // stale id (e.g. deleted custom exercise)
  const rec = bests[id];
  const beast = rec && typeof rec.mmr === "number" ? classify(rec.mmr) : null;
  return { name: ex.name, beast, mmr: rec && typeof rec.mmr === "number" ? rec.mmr : null };
}

// Build <optgroup>-grouped <option>s for the favorite-lift <select>, preserving the
// catalog's group order and pre-selecting the current favorite. Leads with a "none"
// option. Called only from renderProfile (never at top level — load-order safe).
function favoriteSelectHtml() {
  const cur = profile.favoriteExercise || "";
  const groups = [];                             // [group, ex[]] in first-seen order
  EXERCISES().forEach((ex) => {
    let g = groups.find((x) => x[0] === ex.group);
    if (!g) { g = [ex.group, []]; groups.push(g); }
    g[1].push(ex);
  });
  let html = `<option value=""${cur ? "" : " selected"}>None</option>`;
  groups.forEach(([group, list]) => {
    html += `<optgroup label="${escapeHtml(group || "Other")}">`;
    list.forEach((ex) => {
      const sel = ex.id === cur ? " selected" : "";
      html += `<option value="${escapeHtml(ex.id)}"${sel}>${escapeHtml(ex.name)}</option>`;
    });
    html += `</optgroup>`;
  });
  return html;
}

function renderProfile() {
  const b = overallBeast();
  const mmr = overallMMR();
  const hero = document.getElementById("profileHero");
  if (hero) {
    hero.style.setProperty("--c", b ? b.color : "#5b6168");
    const name = profile.name ? profile.name : "Unnamed Lifter";
    const rankTxt = b ? `${b.emoji} ${b.name}` : "🥚 Unranked";
    const ms = memberSince();
    // equipped cosmetics: frame (avatar ring), nameColor (display name), border (card).
    const fr = equippedCosmetic("frame");
    const nc = equippedCosmetic("nameColor");
    const bd = equippedCosmetic("border");
    if (bd) {
      hero.style.borderColor = bd.color;
      hero.style.boxShadow = `0 0 0 1px ${bd.color} inset, 0 0 26px ${hexA(bd.glow || bd.color, 0.5)}`;
    } else {
      hero.style.borderColor = "";
      hero.style.boxShadow = "";
    }
    const frStyle = frameStyleCss(fr);
    const ncStyle = nameColorCss(nc);
    hero.innerHTML = `
      <div class="ph-avatar"${frStyle ? ` style="${frStyle}"` : ""}>${avatarInner()}</div>
      <div class="ph-name"${ncStyle ? ` style="${ncStyle}"` : ""}>${escapeHtml(name)}</div>
      ${profile.username ? `<div class="ph-handle">@${escapeHtml(profile.username)}</div>` : ""}
      <div class="ph-rank">${rankTxt}</div>
      <div class="ph-mmr"><span>Overall MMR</span><b>${mmr != null ? mmr.toLocaleString() : "—"}</b></div>
      ${profile.bio ? `<div class="ph-bio">${escapeHtml(profile.bio)}</div>` : ""}
      ${ms ? `<div class="ph-member">Member since ${ms}</div>` : ""}`;
  }

  const statsBox = document.getElementById("profileStats");
  if (statsBox) {
    const tl = topLift();
    const tlTxt = tl ? `${tl.beast ? tl.beast.emoji + " " : ""}${tl.name}` : "—";
    const fav = favoriteLift();
    let favHtml = "";
    if (fav) {
      const tail = fav.beast ? ` · ${fav.beast.emoji} ${fav.mmr.toLocaleString()} MMR` : "";
      favHtml = `<div class="pstat pstat-fav"><b style="font-size:15px;line-height:1.5">${escapeHtml(fav.name)}${tail}</b><span>favorite lift</span></div>`;
    }
    statsBox.innerHTML = `
      <div class="pstat"><b>${computeStreak()}</b><span>day streak</span></div>
      <div class="pstat"><b>${workouts.length.toLocaleString()}</b><span>workouts</span></div>
      <div class="pstat"><b>${sets.length.toLocaleString()}</b><span>sets logged</span></div>
      <div class="pstat"><b style="font-size:15px;line-height:1.5">${escapeHtml(tlTxt)}</b><span>top lift</span></div>
      ${favHtml}`;
  }

  renderProfileAchievements();

  // populate the edit fields from the stored profile
  const nameI = document.getElementById("peName");
  const bioI = document.getElementById("peBio");
  const bwI = document.getElementById("peBw");
  const favI = document.getElementById("peFav");
  const av = document.getElementById("peAvatarPreview");
  if (nameI) nameI.value = profile.name || "";
  if (bioI) bioI.value = profile.bio || "";
  if (bwI) bwI.value = profile.bodyweight || "";
  if (favI) favI.innerHTML = favoriteSelectHtml();   // rebuild + pre-select current favorite
  if (av) av.innerHTML = avatarInner();
  updateBioCount();
  refreshAvatars();
}

// small HTML escaper for user-entered name/bio shown via innerHTML.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function updateBioCount() {
  const bioI = document.getElementById("peBio");
  const c = document.getElementById("peBioCount");
  if (bioI && c) c.textContent = `${bioI.value.length} / 160`;
}

// ---- profile edit wiring ----
// stagedAvatar holds a freshly-picked (downscaled) data URL until Save; null means
// "no change", "" means "remove". Lets the user preview before committing.
let stagedAvatar = null;
(function wireProfile() {
  const fileInput = document.getElementById("peAvatarInput");
  const pickBtn = document.getElementById("peAvatarPick");
  const removeBtn = document.getElementById("peAvatarRemove");
  const preview = document.getElementById("peAvatarPreview");
  const bioI = document.getElementById("peBio");
  const saveBtn = document.getElementById("peSave");
  const savedLbl = document.getElementById("peSaved");

  if (pickBtn && fileInput) pickBtn.addEventListener("click", () => fileInput.click());
  if (fileInput) fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    downscaleImage(f, 256, 0.7).then((dataUrl) => {
      stagedAvatar = dataUrl;
      if (preview) preview.innerHTML = `<img src="${dataUrl}" alt="" />`;
    }).catch(() => { alert("Couldn't read that image. Try another. 🦎"); });
    fileInput.value = "";   // allow re-picking the same file
  });
  if (removeBtn) removeBtn.addEventListener("click", () => {
    stagedAvatar = "";
    if (preview) preview.innerHTML = "🦎";
  });
  if (bioI) bioI.addEventListener("input", updateBioCount);
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const nameI = document.getElementById("peName");
    const bwI = document.getElementById("peBw");
    const favI = document.getElementById("peFav");
    profile.name = (nameI ? nameI.value : "").trim().slice(0, 24);
    profile.bio = (bioI ? bioI.value : "").trim().slice(0, 160);
    // favorite: store the exId, but only if it's still a real catalog exercise.
    const favVal = favI ? favI.value.trim() : (profile.favoriteExercise || "");
    profile.favoriteExercise = (favVal && exById(favVal)) ? favVal : "";
    if (stagedAvatar !== null) profile.avatar = stagedAvatar;   // committed picture change
    stagedAvatar = null;
    // bodyweight goes through the shared applyBodyweight (logs the trend + recomputes
    // MMR + saves profile). When unchanged it's a harmless no-op resave.
    applyBodyweight(bwI ? bwI.value : profile.bodyweight);
    save();                          // persist name/bio/avatar (triggers cloud auto-push)
    refreshAvatars();
    renderProfile();
    // name/avatar may have changed — refresh the public leaderboard row (debounced,
    // guarded; only does anything when logged in with a username set).
    try { if (typeof publishPublicProfile === "function") publishPublicProfile(); } catch (e) {}
    if (savedLbl) {
      savedLbl.classList.remove("hidden");
      setTimeout(() => savedLbl.classList.add("hidden"), 1800);
    }
    if (soundOn) blip();
  });
})();

// Downscale + center-crop an image File to a square `size`×`size` JPEG data URL at
// `quality`. Keeps the avatar tiny enough for localStorage AND the cloud JSON blob.
function downscaleImage(file, size, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = size; cv.height = size;
        const ctx = cv.getContext("2d");
        const side = Math.min(img.width, img.height);     // center-crop to a square
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL("image/jpeg", quality));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img load failed")); };
    img.src = url;
  });
}

// ===== rank-up celebration =====
// Two flavors, picked by `old`:
//   old == null  → user was UNRANKED (egg state). Egg-hatch reveal.
//   old present  → real prior beast. Old badge morphs/flips out, new badge reveals.
// Show one rank-up celebration. `old` null => egg-hatch; a beast => old→new swap.
// `done` (optional) fires once when the celebration is dismissed (tap or auto),
// exactly once — used to chain queued celebrations one by one at workout finish.
function celebrate(b, ex, old, done) {
  const ru = document.getElementById("rankup");
  ru.style.setProperty("--c", b.color);
  const sub = `MMR ${beastRange(b)} on ${ex.name}`;
  if (old) {
    // old → new replacement
    ru.style.setProperty("--oc", old.color);
    ru.innerHTML = `
      <div class="ru-bang">Rank Up</div>
      <div class="ru-stage ru-stage-swap">
        <div class="ru-old"><div class="ru-old-emoji">${old.emoji}</div><div class="ru-old-name">${old.name}</div></div>
        <div class="ru-arrow">▼</div>
        <div class="ru-new"><div class="ru-emoji">${b.emoji}</div><div class="ru-shine"></div></div>
      </div>
      <div class="ru-name">${b.name}</div>
      <div class="ru-sub">${sub}</div>
      <div class="ru-tap">tap to continue</div>`;
  } else {
    // egg-hatch reveal (unranked → first rank)
    ru.innerHTML = `
      <div class="ru-bang">Hatched</div>
      <div class="ru-stage ru-stage-egg">
        <div class="ru-egg">🥚</div>
        <div class="ru-new"><div class="ru-emoji">${b.emoji}</div><div class="ru-shine"></div></div>
      </div>
      <div class="ru-name">${b.name}</div>
      <div class="ru-sub">${sub}</div>
      <div class="ru-tap">tap to continue</div>`;
  }
  ru.classList.remove("hidden");
  // fire SFX + haptics as the celebration opens (gated by the sound toggle)
  if (soundOn) {
    if (old) { playRankUpSfx(); buzz([40, 60, 40]); }            // swap: double pulse
    else { playHatchSfx(); buzz([30, 50, 30, 50, 120]); }        // hatch: longer flourish
  }
  // dismissal is one-shot: whichever of tap / auto-timeout fires first wins, then
  // both the listener and the timer are torn down so we can't double-advance.
  let closed = false;
  let timer = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    ru.classList.add("hidden");
    ru.removeEventListener("click", close);
    if (typeof done === "function") done();
  };
  ru.addEventListener("click", close);
  timer = window.setTimeout(close, 3600);
}

// Play a list of queued rank-up celebrations one by one, then run `after`.
// Each entry is { beast, ex, old } (old null => egg hatch). The next celebration
// only starts once the previous is dismissed (tap or auto-timeout), so they never
// stack. Empty queue jumps straight to `after`.
function playCelebrations(queue, after) {
  let k = 0;
  const next = () => {
    if (k >= queue.length) { if (typeof after === "function") after(); return; }
    const c = queue[k++];
    celebrate(c.beast, c.ex, c.old, next);
  };
  next();
}

// ===== history =====
function renderHistory() {
  const streak = computeStreak();
  document.getElementById("historyStreak").innerHTML =
    streak > 0 ? `🔥 ${streak}-day streak — keep feeding the beast.` : `No streak yet. Log a workout today to start one. 🦎`;

  // personal records
  const prBox = document.getElementById("prList");
  const ranked = EXERCISES().filter((e) => bests[e.id]);
  if (!ranked.length) {
    prBox.innerHTML = `<p class="empty">No PRs yet.</p>`;
  } else {
    prBox.innerHTML = "";
    ranked.sort((a, b) => bests[b.id].oneRM - bests[a.id].oneRM).forEach((e) => {
      const rec = bests[e.id]; const b = classify(rec.mmr) || byId(rec.beast) || BEASTS[0];
      const row = document.createElement("div");
      row.className = "rankrow"; row.style.setProperty("--c", b.color);
      row.innerHTML = `
        <div class="rankrow-top">
          <span class="rankrow-ex">${e.name}</span>
          <span class="rankrow-beast">${b.emoji} ~${rec.oneRM} lb <small>· ${prettyDate(rec.date)}</small></span>
        </div>`;
      prBox.appendChild(row);
    });
  }

  // per-day log
  const dayBox = document.getElementById("dayList");
  const byDay = {};
  sets.forEach((s) => { (byDay[s.date] ||= []).push(s); });
  const days = Object.keys(byDay).sort().reverse();
  if (!days.length) { dayBox.innerHTML = `<p class="empty">No workouts logged yet.</p>`; return; }
  dayBox.innerHTML = "";
  days.forEach((d) => {
    const daySets = byDay[d];
    const topBeast = daySets.map((s) => classify(s.mmr) || byId(s.beast)).filter(Boolean)
      .sort((a, b) => tierOf(b.id) - tierOf(a.id))[0] || BEASTS[0];
    const row = document.createElement("div");
    row.className = "dayrow";
    row.innerHTML = `
      <div>
        <div class="d-date">${prettyDate(d)}</div>
        <div class="d-meta">${daySets.length} set${daySets.length > 1 ? "s" : ""} · top ${topBeast.name}</div>
      </div>
      <div class="d-beast">${topBeast.emoji}</div>`;
    dayBox.appendChild(row);
  });
}

// ===== flex card =====
const flexModal = document.getElementById("flexModal");
document.getElementById("flexBtn").addEventListener("click", () => {
  const b = overallBeast();
  const streak = computeStreak();
  const ranked = EXERCISES().filter((e) => bests[e.id])
    .sort((a, b2) => bests[b2.id].oneRM - bests[a.id].oneRM).slice(0, 3);
  const lifts = ranked.map((e) => {
    const rec = bests[e.id];
    const fb = classify(rec.mmr) || byId(rec.beast) || BEASTS[0];
    return `<div class="fc-lift"><span>${fb.emoji} ${e.name}</span><b>~${rec.oneRM} lb</b></div>`;
  }).join("") || `<div class="fc-lift"><span>No lifts logged yet</span><b>—</b></div>`;

  document.getElementById("flexCard").innerHTML = `
    <img src="logo.png" alt="REPTILIFT" />
    <div class="fc-emoji">${b ? b.emoji : "🥚"}</div>
    <div class="fc-rank">${b ? b.name : "Unranked"}</div>
    <div class="fc-tier">${b ? `MMR ${beastRange(b)}` : "Log a workout to rank up"}</div>
    <div class="fc-stats">
      <div class="fc-stat"><b>${overallMMR() != null ? overallMMR().toLocaleString() : "—"}</b><span>MMR</span></div>
      <div class="fc-stat"><b>${streak}</b><span>day streak</span></div>
      <div class="fc-stat"><b>${Object.keys(bests).length}</b><span>ranked lifts</span></div>
    </div>
    <div class="fc-lifts">${lifts}</div>`;
  flexModal.classList.remove("hidden");
});
document.getElementById("flexClose").addEventListener("click", () => flexModal.classList.add("hidden"));
flexModal.addEventListener("click", (e) => { if (e.target === flexModal) flexModal.classList.add("hidden"); });

// ===== progress charts =====
// All charts are hand-drawn inline SVG (no libs) so they work offline in the PWA.
// They're responsive (viewBox + width:100%), readable on a phone, gold-on-dark, and
// degrade gracefully: an empty series shows a friendly message, a single point shows
// a dot + note, a flat line still renders (min/max collapse handled).

// Build a responsive line/area chart SVG from a series of { x:Date-ish label, v:Number }.
// pts: [{ label, value }]; opts: { unit, color, fmt, area }. Returns an HTML string.
function svgLineChart(pts, opts = {}) {
  const color = opts.color || "#f2c14e";
  const fmt = opts.fmt || ((n) => Math.round(n).toLocaleString());
  if (!pts || !pts.length) {
    return `<div class="chart-empty">${opts.empty || "No data yet — log some workouts to see this chart."}</div>`;
  }
  // chart geometry (viewBox units; scales to container via width:100%)
  const W = 600, H = 240, padL = 46, padR = 16, padT = 16, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const vals = pts.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }           // flat line → give it room
  const span = max - min || 1;
  const n = pts.length;
  const xAt = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v) => padT + innerH - ((v - min) / span) * innerH;

  // horizontal gridlines + y labels (4 rows)
  let grid = "", ylabels = "";
  for (let g = 0; g <= 3; g++) {
    const v = min + (span * g) / 3;
    const y = yAt(v);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="ch-grid"/>`;
    ylabels += `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" class="ch-ylab">${fmt(v)}</text>`;
  }
  const linePts = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ");
  // area path under the line
  const areaPath = `M ${xAt(0).toFixed(1)},${(padT + innerH).toFixed(1)} ` +
    pts.map((p, i) => `L ${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ") +
    ` L ${xAt(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
  // markers (cap count so dense series stay clean)
  const showDots = n <= 24;
  const dots = showDots ? pts.map((p, i) =>
    `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="${n === 1 ? 5 : 3}" class="ch-dot"/>`).join("") : "";
  // x labels: first + last (+ middle when room)
  const xlabAt = (i) => `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" class="ch-xlab" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${pts[i].label}</text>`;
  let xlabels = xlabAt(0);
  if (n > 1) xlabels += xlabAt(n - 1);
  if (n > 4) xlabels += xlabAt(Math.floor((n - 1) / 2));

  const grad = "g" + Math.random().toString(36).slice(2, 8);
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" style="--ch:${color}">
    <defs><linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.32"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    ${opts.area === false ? "" : `<path d="${areaPath}" fill="url(#${grad})"/>`}
    ${n > 1 ? `<polyline points="${linePts}" class="ch-line"/>` : ""}
    ${dots}
    ${ylabels}
    ${xlabels}
  </svg>` +
  `<div class="chart-foot"><span>${pts[0].label}</span>` +
   `<span class="chart-range">${fmt(min)}–${fmt(max)}${opts.unit ? " " + opts.unit : ""}</span>` +
   `<span>${pts[n - 1].label}</span></div>`;
}

// short axis date label from a YYYY-MM-DD string (e.g. "Jun 19")
function shortDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// 1) Overall MMR over time — REPLAY all sets in chronological order, maintaining a
// running best per-exercise MMR (mirrors the live `bests` logic), and sample the
// overall MMR (= average of those running bests) at each DISTINCT workout date.
// This faithfully reconstructs how overallMMR() would have read after each day's
// lifting, so the curve matches today's value at the end. Sets without a numeric
// mmr (logged before bodyweight was set) are skipped — same as overallMMR().
function overallMMRSeries() {
  const chron = sets.filter((s) => typeof s.mmr === "number")
    .slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || (a.date < b.date ? -1 : 1));
  const runningBest = {};                 // exId -> best mmr so far
  const byDate = {};                      // date -> overall MMR snapshot after that day
  chron.forEach((s) => {
    if (!(s.exId in runningBest) || s.mmr > runningBest[s.exId]) runningBest[s.exId] = s.mmr;
    const vals = Object.values(runningBest);
    if (vals.length) byDate[s.date] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  });
  return Object.keys(byDate).sort()
    .map((d) => ({ label: shortDate(d), value: byDate[d] }));
}

// 2) Per-lift MMR over time for one exercise — its sets' MMR by date (best per day,
// so multiple sets in a session read as that session's peak).
function liftMMRSeries(exId) {
  const rows = sets.filter((s) => s.exId === exId && typeof s.mmr === "number");
  const byDate = {};
  rows.forEach((s) => { byDate[s.date] = Math.max(byDate[s.date] ?? -1, s.mmr); });
  return Object.keys(byDate).sort().map((d) => ({ label: shortDate(d), value: byDate[d] }));
}

// 3) Bodyweight trend from the dated bwLog.
function bodyweightSeries() {
  return bwLog.slice().sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => ({ label: shortDate(e.date), value: e.bw }));
}

// 4) Per-session volume (Σ load×reps) reconstructed from sets grouped by date.
function volumeSeries() {
  const bw = profile.bodyweight || 0;
  const byDate = {};
  sets.forEach((s) => {
    const ex = exById(s.exId);
    // re-derive load×reps. Stored sets keep `detail` + oneRM, not raw load, so back
    // it out: weighted lifts parse the leading number; bodyweight lifts use bw*factor
    // (+ any added in the detail). Reps come from the trailing "× N".
    const repsM = /×\s*(\d+)/.exec(s.detail || "");
    const reps = repsM ? parseInt(repsM[1], 10) : 0;
    let load = 0;
    if (ex && ex.type === "bodyweight") {
      const addM = /\+\s*(\d+)/.exec(s.detail || "");
      load = bw * ex.factor + (addM ? parseInt(addM[1], 10) : 0);
    } else {
      const wM = /(\d+)/.exec(s.detail || "");
      load = wM ? parseInt(wM[1], 10) : 0;
    }
    byDate[s.date] = (byDate[s.date] || 0) + load * reps;
  });
  return Object.keys(byDate).sort()
    .map((d) => ({ label: shortDate(d), value: Math.round(byDate[d]) }))
    .filter((p) => p.value > 0);
}

function renderProgress() {
  // overall MMR
  const ob = overallBeast();
  const oColor = ob ? ob.color : "#f2c14e";
  const oSeries = overallMMRSeries();
  document.getElementById("progOverall").innerHTML = svgLineChart(oSeries, {
    color: oColor, unit: "MMR",
    empty: profile.bodyweight ? "Log a few workouts to chart your overall MMR." : "Set your bodyweight in Log to start tracking MMR.",
  });

  // per-lift picker (only lifts with mmr history)
  const sel = document.getElementById("progLiftSelect");
  const logged = EXERCISES().filter((e) => sets.some((s) => s.exId === e.id && typeof s.mmr === "number"));
  if (!logged.length) {
    sel.innerHTML = `<option>No lifts yet</option>`;
    sel.disabled = true;
    document.getElementById("progLift").innerHTML = svgLineChart([], { empty: "Log a ranked set to chart a lift." });
  } else {
    sel.disabled = false;
    // keep prior selection if still valid, else pick the most-logged lift
    const prev = sel.value;
    const valid = logged.some((e) => e.id === prev);
    sel.innerHTML = logged.map((e) => `<option value="${e.id}">${e.name}</option>`).join("");
    sel.value = valid ? prev : logged[0].id;
    drawLiftChart(sel.value);
  }

  // bodyweight
  const bwS = bodyweightSeries();
  document.getElementById("progBw").innerHTML = svgLineChart(bwS, {
    color: "#36c47b", unit: "lb",
    empty: "Set your bodyweight in Log to start a trend.",
  }) + (bwS.length === 1 ? `<p class="chart-note">Log your weight over time to see a trend.</p>` : "");

  // volume
  document.getElementById("progVolume").innerHTML = svgLineChart(volumeSeries(), {
    color: "#7c83ff", unit: "lb",
    empty: "Finish a workout to chart session volume.",
  });
}
function drawLiftChart(exId) {
  const ex = exById(exId);
  const rec = ex ? bests[ex.id] : null;
  const b = rec ? classify(rec.mmr) : null;
  document.getElementById("progLift").innerHTML = svgLineChart(liftMMRSeries(exId), {
    color: b ? b.color : "#f2c14e", unit: "MMR",
    empty: "No ranked sets for this lift yet.",
  });
}
document.getElementById("progLiftSelect").addEventListener("change", (e) => drawLiftChart(e.target.value));

// ===== shareable rank card (canvas → Web Share file / PNG download) =====
const cardModal = document.getElementById("cardModal");
const rankCanvas = document.getElementById("rankCanvas");

// Draw the whole card on the 1080×1350 canvas: dark gradient bg, logo wordmark,
// the user's overall beast (emoji + name + color), big MMR, top lifts, streak.
// Everything is drawn in code — no external image assets required.
function drawRankCard() {
  const cv = rankCanvas, ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const b = overallBeast();
  // equipped rank-card theme (owner-only). Guarded: a missing/removed theme → default
  // palette (beast-accent green card). theme.accent overrides the beast color when set.
  const theme = equippedCosmetic("theme");
  const accent = theme && theme.accent ? theme.accent : (b ? b.color : "#f2c14e");
  const wordmarkColor = theme && theme.wordmark ? theme.wordmark : "#f2c14e";
  const bgTop = theme && theme.bg ? theme.bg[0] : "#0e2a1f";
  const bgBot = theme && theme.bg ? theme.bg[1] : "#06140d";
  const mmr = overallMMR();
  const streak = computeStreak();
  const liftCount = Object.keys(bests).length;

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, bgTop); bg.addColorStop(1, bgBot);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // accent glow at top
  const glow = ctx.createRadialGradient(W / 2, 120, 40, W / 2, 120, 720);
  glow.addColorStop(0, hexA(accent, 0.30)); glow.addColorStop(1, hexA(accent, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // border frame
  ctx.strokeStyle = hexA(accent, 0.55); ctx.lineWidth = 6;
  roundRect(ctx, 24, 24, W - 48, H - 48, 40); ctx.stroke();

  ctx.textAlign = "center";

  // wordmark
  ctx.fillStyle = wordmarkColor;
  ctx.font = "700 64px Rajdhani, sans-serif";
  ctx.fillText("REPTILIFT", W / 2, 150);
  ctx.fillStyle = hexA("#eaf5ee", 0.6);
  ctx.font = "600 30px Rajdhani, sans-serif";
  ctx.fillText("CLIMB THE FOOD CHAIN", W / 2, 198);

  // profile avatar (circle) + display name, if set. The avatar image is preloaded
  // before drawRankCard runs (see openRankCard), so cardAvatarImg is ready here;
  // guarded so a missing/failed image just skips the picture.
  const hasName = profile.name && profile.name.trim();
  if ((cardAvatarImg && cardAvatarImg.complete && cardAvatarImg.naturalWidth) || hasName) {
    const cx = W / 2, cy = 280, r = 60;
    if (cardAvatarImg && cardAvatarImg.complete && cardAvatarImg.naturalWidth) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
      ctx.drawImage(cardAvatarImg, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(accent, 0.7); ctx.lineWidth = 4; ctx.stroke();
    }
    if (hasName) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#eaf5ee";
      ctx.font = "700 46px Rajdhani, sans-serif";
      ctx.fillText(profile.name.trim(), W / 2, (cardAvatarImg && cardAvatarImg.complete && cardAvatarImg.naturalWidth) ? 396 : 300);
    }
  }

  // beast emoji (big)
  ctx.font = "300px sans-serif";
  ctx.shadowColor = accent; ctx.shadowBlur = 60;
  ctx.fillText(b ? b.emoji : "🥚", W / 2, 560);
  ctx.shadowBlur = 0;

  // beast name
  ctx.fillStyle = accent;
  ctx.font = "700 84px Rajdhani, sans-serif";
  ctx.fillText(b ? b.name : "Unranked", W / 2, 680);
  ctx.fillStyle = hexA("#eaf5ee", 0.55);
  ctx.font = "600 34px Rajdhani, sans-serif";
  ctx.fillText(b ? `MMR BAND ${beastRange(b)}` : "Log a workout to rank up", W / 2, 728);

  // big MMR number
  ctx.fillStyle = wordmarkColor;
  ctx.font = "700 200px Rajdhani, sans-serif";
  ctx.shadowColor = hexA(wordmarkColor, 0.5); ctx.shadowBlur = 40;
  ctx.fillText(mmr != null ? String(mmr) : "—", W / 2, 920);
  ctx.shadowBlur = 0;
  ctx.fillStyle = hexA("#eaf5ee", 0.6);
  ctx.font = "600 36px Rajdhani, sans-serif";
  ctx.fillText("OVERALL MMR · 0–800", W / 2, 968);

  // stat chips: streak + ranked lifts
  drawChip(ctx, W / 2 - 250, 1020, 240, 100, `${streak}`, "DAY STREAK", accent);
  drawChip(ctx, W / 2 + 10, 1020, 240, 100, `${liftCount}`, "RANKED LIFTS", accent);

  // top lifts
  const ranked = EXERCISES().filter((e) => bests[e.id])
    .sort((a, b2) => bests[b2.id].oneRM - bests[a.id].oneRM).slice(0, 3);
  ctx.textAlign = "left";
  let ly = 1190;
  if (ranked.length) {
    ranked.forEach((e) => {
      const rec = bests[e.id];
      const fb = classify(rec.mmr) || byId(rec.beast) || BEASTS[0];
      ctx.font = "600 40px Rajdhani, sans-serif";
      ctx.fillStyle = "#eaf5ee";
      ctx.textAlign = "left";
      ctx.fillText(`${fb.emoji}  ${e.name}`, 90, ly);
      ctx.textAlign = "right";
      ctx.fillStyle = accent;
      ctx.fillText(`~${rec.oneRM} lb`, W - 90, ly);
      ly += 56;
    });
  } else {
    ctx.textAlign = "center";
    ctx.fillStyle = hexA("#eaf5ee", 0.5);
    ctx.font = "600 36px Rajdhani, sans-serif";
    ctx.fillText("No lifts logged yet", W / 2, 1200);
  }
  ctx.textAlign = "left";
}
// rounded-rect helper
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// stat chip with big number + label
function drawChip(ctx, x, y, w, h, big, label, accent) {
  ctx.fillStyle = hexA(accent, 0.10);
  ctx.strokeStyle = hexA(accent, 0.4); ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 18); ctx.fill(); ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = "#eaf5ee";
  ctx.font = "700 52px Rajdhani, sans-serif";
  ctx.fillText(big, x + w / 2, y + 56);
  ctx.fillStyle = hexA("#eaf5ee", 0.6);
  ctx.font = "600 22px Rajdhani, sans-serif";
  ctx.fillText(label, x + w / 2, y + 86);
}
// "#rrggbb" + alpha → rgba() string (canvas has no color-mix).
function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), bl = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${bl},${a})`;
}

// preloaded avatar image for the rank card. Loaded from the profile data URL (or
// cleared if none) before each open; on load it triggers one redraw so the picture
// lands even if it wasn't ready on the first synchronous draw.
let cardAvatarImg = null;
// open the rank-card modal: draw, then show. Fonts may load a beat late on first
// paint, so redraw shortly after to pick up Rajdhani if it wasn't ready.
function openRankCard() {
  // (re)load the avatar so the card can draw it; guarded so failures just skip it.
  if (profile.avatar) {
    cardAvatarImg = new Image();
    cardAvatarImg.onload = () => { try { drawRankCard(); } catch (e) {} };
    cardAvatarImg.onerror = () => { cardAvatarImg = null; };
    cardAvatarImg.src = profile.avatar;
  } else {
    cardAvatarImg = null;
  }
  drawRankCard();
  cardModal.classList.remove("hidden");
  setTimeout(drawRankCard, 120);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawRankCard).catch(() => {});
}
function closeRankCard() { cardModal.classList.add("hidden"); }

// Share the canvas: prefer the Web Share API with a PNG file (native sheet on
// mobile); otherwise download the PNG. Both paths are feature-detected and guarded
// so nothing throws on unsupported browsers.
async function shareRankCard() {
  const hint = document.getElementById("cardHint");
  const filename = "reptilift-rank.png";
  // try Web Share with a file first
  try {
    const blob = await new Promise((res) => rankCanvas.toBlob(res, "image/png"));
    if (blob && navigator.canShare) {
      const file = new File([blob], filename, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Reptilift", text: "My Reptilift rank 🦎" });
        return;
      }
    }
    // fallback: download the PNG
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (hint) hint.textContent = "Saved the image — share it anywhere 🦎";
      return;
    }
    throw new Error("no blob");
  } catch (e) {
    // last-ditch: data-URL download (and don't surface AbortError from a cancelled share)
    if (e && e.name === "AbortError") return;
    try {
      const a = document.createElement("a");
      a.href = rankCanvas.toDataURL("image/png"); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      if (hint) hint.textContent = "Saved the image — share it anywhere 🦎";
    } catch (e2) {
      if (hint) hint.textContent = "Couldn't share on this device — screenshot it instead 📸";
    }
  }
}
document.getElementById("progShareBtn").addEventListener("click", openRankCard);
document.getElementById("ranksShareBtn").addEventListener("click", openRankCard);
document.getElementById("cardShareBtn").addEventListener("click", shareRankCard);
document.getElementById("cardClose").addEventListener("click", closeRankCard);
cardModal.addEventListener("click", (e) => { if (e.target === cardModal) closeRankCard(); });

// ===== first-run onboarding wizard =====
// A short, skippable, on-brand wizard shown ONCE to brand-new users. The
// onboarded flag lives in profile.onboarded (synced inside reptilift_profile), so a
// cloud save with onboarded=true suppresses it on other devices. Everything here is
// defined as functions only — nothing runs at load time. maybeShowOnboarding() is
// called from the init block AFTER the intro is wired up, so it's load-order safe.
//
// New-user detection: NOT onboarded AND essentially no data (no bodyweight, no logged
// sets, no finished workouts). Existing users are implicitly flagged onboarded so the
// wizard never appears for them.
const OB_STEPS = ["welcome", "name", "bw", "cloud", "finish"];
let obIndex = 0;
let obActiveSteps = OB_STEPS.slice();   // "cloud" is dropped when Supabase isn't configured

function userHasData() {
  return !!(
    (profile && profile.bodyweight) ||
    (Array.isArray(sets) && sets.length) ||
    (Array.isArray(workouts) && workouts.length)
  );
}

function markOnboarded() {
  profile.onboarded = true;
  save();                          // persists profile (auto-syncs via SYNC_KEYS)
}

function closeOnboarding() {
  const ov = document.getElementById("onboard");
  if (!ov) return;
  ov.classList.add("hidden");
  ov.setAttribute("aria-hidden", "true");
}

// build the progress dots + show only the current step
function obRender() {
  const dotsEl = document.getElementById("obDots");
  if (dotsEl) {
    dotsEl.innerHTML = obActiveSteps
      .map((_, i) => `<span class="ob-dot${i === obIndex ? " on" : ""}"></span>`)
      .join("");
  }
  const cur = obActiveSteps[obIndex];
  document.querySelectorAll("#onboard .ob-step").forEach((el) => {
    el.classList.toggle("active", el.dataset.step === cur);
  });
  const back = document.getElementById("obBack");
  const next = document.getElementById("obNext");
  if (back) back.classList.toggle("hidden", obIndex === 0);
  // the cloud + finish steps carry their own action buttons, so hide the generic Next there
  if (next) next.classList.toggle("hidden", cur === "cloud" || cur === "finish");
}

function obGoTo(i) {
  obIndex = Math.max(0, Math.min(obActiveSteps.length - 1, i));
  obRender();
}

// validate + persist the current step before advancing. Returns false to block.
function obCommitStep() {
  const cur = obActiveSteps[obIndex];
  if (cur === "name") {
    const nameEl = document.getElementById("obName");
    const userEl = document.getElementById("obUser");
    const errEl = document.getElementById("obUserErr");
    if (errEl) errEl.textContent = "";
    if (nameEl) profile.name = (nameEl.value || "").trim().slice(0, 24);
    if (userEl) {
      const raw = (userEl.value || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (raw) {
        if (!USERNAME_RE.test(raw)) {
          if (errEl) errEl.textContent = "3–20 chars: lowercase letters, numbers, underscores.";
          return false;   // only block when they typed something invalid; blank is fine
        }
        profile.username = raw;
      }
    }
    save();
    try { renderHome(); } catch (e) {}
    return true;
  }
  if (cur === "bw") {
    const bwEl = document.getElementById("obBw");
    const errEl = document.getElementById("obBwErr");
    if (errEl) errEl.textContent = "";
    const v = parseInt(bwEl ? bwEl.value : "", 10);
    if (!v || v <= 0) {
      if (errEl) errEl.textContent = "Enter your bodyweight to continue.";
      return false;
    }
    applyBodyweight(v);   // stores it, seeds the trend log, recomputes MMR
    return true;
  }
  return true;
}

function maybeShowOnboarding() {
  const ov = document.getElementById("onboard");
  if (!ov) return;
  // Existing users (any real data) → flag them so it never shows, and bail.
  if (userHasData() && !profile.onboarded) { markOnboarded(); return; }
  if (profile.onboarded || userHasData()) return;

  // drop the cloud step gracefully when Supabase isn't configured
  obActiveSteps = OB_STEPS.filter((s) => s !== "cloud" || (typeof CLOUD_CONFIGURED !== "undefined" && CLOUD_CONFIGURED));
  obIndex = 0;

  // prefill from anything already in the profile
  const nameEl = document.getElementById("obName");
  const userEl = document.getElementById("obUser");
  const bwEl   = document.getElementById("obBw");
  if (nameEl) nameEl.value = profile.name || "";
  if (userEl) userEl.value = profile.username || "";
  if (bwEl)   bwEl.value = profile.bodyweight || "";

  ov.classList.remove("hidden");
  ov.setAttribute("aria-hidden", "false");
  obRender();
}

(function wireOnboarding() {
  const ov = document.getElementById("onboard");
  if (!ov) return;
  const skip = () => { markOnboarded(); closeOnboarding(); };

  const skipBtn = document.getElementById("obSkip");
  if (skipBtn) skipBtn.addEventListener("click", skip);

  const nextBtn = document.getElementById("obNext");
  if (nextBtn) nextBtn.addEventListener("click", () => { if (obCommitStep()) obGoTo(obIndex + 1); });

  const backBtn = document.getElementById("obBack");
  if (backBtn) backBtn.addEventListener("click", () => obGoTo(obIndex - 1));

  // cloud step: jump to the Account page sign-up (marks onboarded so we don't re-show)
  const signupBtn = document.getElementById("obSignup");
  if (signupBtn) signupBtn.addEventListener("click", () => {
    markOnboarded();
    closeOnboarding();
    try {
      cloudMode = "signup";
      if (typeof paintMode === "function") paintMode();
      switchTab("account-page");
    } catch (e) { try { switchTab("home"); } catch (e2) {} }
  });
  const laterBtn = document.getElementById("obMaybeLater");
  if (laterBtn) laterBtn.addEventListener("click", () => obGoTo(obIndex + 1));

  // finish: mark done and drop them into the Log tab to start their first workout
  const finishBtn = document.getElementById("obFinish");
  if (finishBtn) finishBtn.addEventListener("click", () => {
    markOnboarded();
    closeOnboarding();
    try { switchTab("log"); } catch (e) {}
  });
})();

// ===== startup animation =====
const appEl = document.getElementById("app");
function introTimers(introEl, firstLoad) {
  introEl.offsetWidth;                                                  // force reflow so a replay restarts clean
  window.setTimeout(() => introEl.classList.add("go"), 700);            // eyes glow open
  window.setTimeout(() => introEl.classList.add("title"), 1900);        // logo wipes in around them
  window.setTimeout(() => introEl.classList.add("look"), 3400);         // eyes blink & dart around
  if (firstLoad && appEl) window.setTimeout(() => appEl.classList.add("ready"), 5200);
  window.setTimeout(() => introEl.classList.add("hide"), 5200);
  window.setTimeout(() => {
    introEl.style.display = "none";
    // first load only: once the intro is out of the way, offer the onboarding wizard
    // to brand-new users (no-op otherwise). Guarded so it never blocks the app.
    if (firstLoad) { try { maybeShowOnboarding(); } catch (e) {} }
  }, 6100);
}
(function () {
  const intro = document.getElementById("intro");
  if (intro && appEl) introTimers(intro, true);
})();
function playIntro() {
  const old = document.getElementById("intro");
  if (!old) return;
  const fresh = old.cloneNode(true);
  fresh.classList.remove("hide", "go", "title", "look");
  fresh.style.display = "flex";
  old.replaceWith(fresh);
  introTimers(fresh, false);
}
const replayBtn = document.getElementById("replayIntro");
if (replayBtn) replayBtn.addEventListener("click", playIntro);

// ===== service worker (offline once hosted; no-op on file://) =====
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ===== migrate older saved data =====
// shapes seen over time: "beastId" string -> {beast,oneRM,date} -> +mmr (old 0–200).
// v2.4: MMR is now the 0–800 strength-standards model. Old stored mmr values are on
// the wrong scale, so recompute every best's mmr from its oneRM + current bodyweight
// and re-derive its beast. If bodyweight is unset, clear mmr so it recomputes later.
(function migrate() {
  let changed = false;
  for (const k in bests) {
    let v = bests[k];
    if (typeof v === "string") {                 // oldest shape: just a beast id
      bests[k] = v = { beast: v, oneRM: 1, date: todayStr() };
      changed = true;
    } else if (!v || typeof v.oneRM !== "number") {
      delete bests[k];
      changed = true;
    }
  }
  for (const k in bests) {
    const v = bests[k];
    const m = mmrForBest(k, v.oneRM);            // null when bodyweight unset
    if (m == null) {
      if (typeof v.mmr === "number") { delete v.mmr; changed = true; }
    } else if (v.mmr !== m) { v.mmr = m; changed = true; }
    const nb = classify(v.mmr);
    const id = nb ? nb.id : null;
    if (v.beast !== id) { v.beast = id; changed = true; }
  }
  if (changed) save();
})();

// ===== init =====
// seed the bodyweight log once from the existing profile weight (safe here: all
// helpers like todayStr() are defined by now) so the first trend chart isn't blank.
if (!bwLog.length && profile.bodyweight) logBodyweight(profile.bodyweight);
rolloverDaily();              // reset daily quests if the calendar day changed
maybeAutoFreeze();            // spend a Streak Freeze if it can save a broken streak
refreshWallet();              // paint balance chips
checkAchievements();          // award any badges already earned by existing data (load-order safe: all helpers defined by now)
renderChart();
renderWorkout();
if (workout) startTicker();   // resume timer if a session was in progress
renderHome();

// ============================================================================
// ===== CLOUD SYNC (Supabase email+password accounts) ========================
// ============================================================================
// Cloud data model — table `progress`, ONE row per user:
//   { user_id uuid pk (= auth.uid()), data jsonb, updated_at timestamptz }
// `data` is a flat object: { reptilift_<key>: <parsed value>, ... } for the 13
// SYNC_KEYS that exist locally. Reads:  select data from progress where user_id=uid
// Writes: upsert { user_id, data, updated_at: now }. Last-write-wins on updated_at.
//
// Degrades gracefully: if SUPA_URL/SUPA_ANON are still placeholders or the
// supabase CDN global is missing, none of this runs and the app stays purely
// local. All elements below are guarded so missing DOM never throws either.

const SUPA_PLACEHOLDER = (v) => !v || /^__.*__$/.test(v);
const CLOUD_CONFIGURED =
  typeof window !== "undefined" &&
  window.supabase && typeof window.supabase.createClient === "function" &&
  !SUPA_PLACEHOLDER(window.SUPA_URL) && !SUPA_PLACEHOLDER(window.SUPA_ANON);

let supa = null;               // the Supabase client (null until configured)
let cloudMode = "signin";      // "signin" | "signup" toggle for the account form
let pushTimer = null;          // debounce handle for scheduleCloudPush

// ---- account UI element handles (all optional-guarded) ----
const ax = {
  wrap:        document.getElementById("account"),
  disabled:    document.getElementById("acctDisabled"),
  loggedOut:   document.getElementById("acctLoggedOut"),
  loggedIn:    document.getElementById("acctLoggedIn"),
  form:        document.getElementById("acctForm"),
  email:       document.getElementById("acctEmail"),
  pass:        document.getElementById("acctPass"),
  err:         document.getElementById("acctErr"),
  submit:      document.getElementById("acctSubmit"),
  toggle:      document.getElementById("acctToggle"),
  intro:       document.getElementById("acctIntro"),
  emailLbl:    document.getElementById("acctEmailLbl"),
  syncLbl:     document.getElementById("acctSyncLbl"),
  logout:      document.getElementById("acctLogout"),
  dot:         document.getElementById("syncDot"),
  chip:        document.getElementById("acctChip"),
  chipLbl:     document.getElementById("acctChipLbl"),
};

// ---- sync status indicator (dot + labels) ----
// state: "off" | "synced" | "saving" | "offline"
function setSyncStatus(state) {
  const map = {
    off:     { dot: "",        chip: "Sign in",  lbl: "" },
    synced:  { dot: "ok",      chip: "Synced",   lbl: "Synced ✓" },
    saving:  { dot: "saving",  chip: "Saving…",  lbl: "Saving…" },
    offline: { dot: "offline", chip: "Offline",  lbl: "Offline — will retry" },
  };
  const m = map[state] || map.off;
  if (ax.dot) ax.dot.className = "syncdot " + m.dot;
  if (ax.syncLbl && state !== "off") ax.syncLbl.textContent = m.lbl;
  // NOTE: the top chip now opens the Profile page, so its label stays "Profile"
  // (sync state lives on the Account page). We intentionally don't relabel it here.
}

// ---- gatherLocal(): the { key: parsedValue } blob for all present SYNC_KEYS ----
function gatherLocal() {
  const data = {};
  SYNC_KEYS.forEach((k) => {
    const raw = localStorage.getItem(k);
    if (raw == null) return;                 // skip missing keys
    try { data[k] = JSON.parse(raw); }
    catch (e) { data[k] = raw; }             // non-JSON (e.g. reptilift_sound "on"/"off")
  });
  return data;
}

function localHasData() {
  // "non-empty" = any meaningful key present (ignore the sound preference alone).
  return SYNC_KEYS.some((k) => k !== "reptilift_sound" && localStorage.getItem(k) != null);
}

// ---- pushCloud(): upsert local blob to the user's row (debounced caller below) ----
async function pushCloud() {
  if (!supa || !cloudUser) return;
  setSyncStatus("saving");
  try {
    const { error } = await supa.from("progress").upsert(
      { user_id: cloudUser.id, data: gatherLocal(), updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    setSyncStatus("synced");
  } catch (e) {
    // network/permission failure — don't crash; next change or reload retries.
    setSyncStatus("offline");
  }
}
function scheduleCloudPush() {
  if (!cloudUser) return;
  setSyncStatus("saving");
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; pushCloud(); }, 1500);
}

// ---- applyCloud(data): overwrite local keys from a cloud blob, then reload ----
// Reload is the bulletproof way to re-init every module-scoped state var. A
// sessionStorage flag tells the post-reload boot NOT to immediately re-pull.
function applyCloud(data) {
  if (!data || typeof data !== "object") return;
  cloudSuppress = true;                      // don't echo these writes back to cloud
  try {
    SYNC_KEYS.forEach((k) => {
      if (k in data) {
        const v = data[k];
        localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    });
  } finally { cloudSuppress = false; }
  sessionStorage.setItem("reptilift_just_synced", "1");   // guard apply→reload→pull loop
  location.reload();
}

// ---- onLogin(user): fetch the row and reconcile cloud vs local ----
async function onLogin(user) {
  cloudUser = user;
  paintAccount();
  // Friends/leaderboard: repaint the page for the signed-in state and publish the
  // public profile once a username is known. Guarded so a missing module/offline
  // never blocks login or sync.
  try { if (typeof onCloudAuthChanged === "function") onCloudAuthChanged(); } catch (e) {}
  // If we JUST applied a cloud save and reloaded, don't re-pull — just push to
  // keep updated_at fresh and clear the guard.
  if (sessionStorage.getItem("reptilift_just_synced")) {
    sessionStorage.removeItem("reptilift_just_synced");
    setSyncStatus("synced");
    return;
  }
  try {
    const { data: row, error } = await supa
      .from("progress").select("data").eq("user_id", user.id).maybeSingle();
    if (error) throw error;

    const cloud = row && row.data;
    const cloudHasData = cloud && typeof cloud === "object" && Object.keys(cloud).length > 0;

    if (!cloudHasData) {
      // New account / no cloud save yet → adopt this device's local data.
      await pushCloud();
      return;
    }
    // Cloud has a save. Decide whether to load it (new device) or keep local.
    if (!localHasData()) {
      applyCloud(cloud);                     // empty device → just take the cloud save
      return;
    }
    const load = confirm(
      "Load your cloud save? This will REPLACE the progress on this device.\n\n" +
      "OK = load cloud save  ·  Cancel = keep this device’s progress (overwrites cloud)"
    );
    if (load) applyCloud(cloud);             // cloud wins (reloads)
    else await pushCloud();                  // local wins — overwrite cloud
  } catch (e) {
    setSyncStatus("offline");
  }
}

function onLogout() {
  cloudUser = null;
  clearTimeout(pushTimer); pushTimer = null;
  cloudMode = "signin";
  paintAccount();                            // local data stays on the device untouched
  try { if (typeof onCloudAuthChanged === "function") onCloudAuthChanged(); } catch (e) {}
}

// ---- account form / UI wiring ----
function paintAccount() {
  if (!ax.wrap) return;
  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");
  hide(ax.disabled); hide(ax.loggedOut); hide(ax.loggedIn);

  // the top chip is the Profile entry point now — always visible, label fixed.
  if (ax.chip) ax.chip.classList.remove("hidden");

  if (!CLOUD_CONFIGURED) {
    show(ax.disabled);
    setSyncStatus("off");
    return;
  }
  if (cloudUser) {
    show(ax.loggedIn);
    if (ax.emailLbl) ax.emailLbl.textContent = cloudUser.email || "(signed in)";
    const acctAv = document.querySelector("#acctLoggedIn .acct-avatar");
    if (acctAv) acctAv.innerHTML = (typeof avatarInner === "function") ? avatarInner() : "🦎";
    setSyncStatus("synced");
  } else {
    show(ax.loggedOut);
    if (ax.dot) ax.dot.className = "syncdot";
    paintMode();
  }
}
function paintMode() {
  const signup = cloudMode === "signup";
  if (ax.submit) ax.submit.textContent = signup ? "Sign up" : "Log in";
  if (ax.pass) ax.pass.autocomplete = signup ? "new-password" : "current-password";
  if (ax.toggle) ax.toggle.innerHTML = signup
    ? "Already have an account? <b>Log in</b>"
    : "Need an account? <b>Sign up</b>";
  if (ax.intro) ax.intro.textContent = signup
    ? "Create an account to back up your progress to the cloud."
    : "Save your progress to the cloud so it follows you to your phone.";
  if (ax.err) ax.err.textContent = "";
}

if (ax.toggle) ax.toggle.addEventListener("click", () => {
  cloudMode = cloudMode === "signup" ? "signin" : "signup";
  paintMode();
});

if (ax.form) ax.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!supa) return;
  const email = (ax.email.value || "").trim();
  const password = ax.pass.value || "";
  if (ax.err) ax.err.textContent = "";
  if (ax.submit) { ax.submit.disabled = true; ax.submit.textContent = "…"; }
  try {
    if (cloudMode === "signup") {
      const { data, error } = await supa.auth.signUp({ email, password });
      if (error) throw error;
      if (data && data.session) {
        // confirmation OFF → active session returned; auth listener runs onLogin.
      } else {
        // confirmation ON → no session yet; user must confirm via email first.
        cloudMode = "signin"; paintMode();   // switch back to log-in view first…
        if (ax.err) {                         // …then show the message (paintMode clears it)
          ax.err.classList.add("ok");
          ax.err.textContent = "Check your email to confirm, then log in.";
        }
      }
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // auth listener fires onLogin on success.
    }
  } catch (err) {
    if (ax.err) { ax.err.classList.remove("ok"); ax.err.textContent = (err && err.message) || "Something went wrong."; }
  } finally {
    // restore the submit button label/state WITHOUT clearing any message we set above.
    if (ax.submit) { ax.submit.disabled = false; ax.submit.textContent = cloudMode === "signup" ? "Sign up" : "Log in"; }
  }
});

if (ax.logout) ax.logout.addEventListener("click", async () => {
  if (!supa) return;
  try { await supa.auth.signOut(); } catch (e) {}
  // onAuthStateChange will fire SIGNED_OUT → onLogout; call it directly too in
  // case the event is delayed.
  onLogout();
});

// Clicking the top avatar chip opens the Profile page (the user's hub). Account &
// Cloud Sign-in is one tap away via a button on that page.
if (ax.chip) ax.chip.addEventListener("click", () => {
  if (typeof switchTab === "function") switchTab("profile-page");
});

// retry a pending push when the network comes back
window.addEventListener("online", () => { if (cloudUser) scheduleCloudPush(); });

// ---- boot the cloud layer ----
(function bootCloud() {
  if (!CLOUD_CONFIGURED) {
    if (ax.err && ax.err.classList) {}        // no-op; keep guards happy
    paintAccount();                           // shows "not set up yet" + hides chip
    return;
  }
  supa = window.supabase.createClient(window.SUPA_URL, window.SUPA_ANON);
  paintAccount();

  // React to all auth transitions (initial session, login, logout, refresh).
  supa.auth.onAuthStateChange((_event, session) => {
    if (session && session.user) {
      if (!cloudUser || cloudUser.id !== session.user.id) onLogin(session.user);
    } else {
      if (cloudUser) onLogout();
    }
  });

  // Also resolve any existing session on first load (covers cold start).
  supa.auth.getSession().then(({ data }) => {
    const s = data && data.session;
    if (s && s.user && !cloudUser) onLogin(s.user);
  }).catch(() => {});
})();

// ============================================================================
// ===== FRIENDS + LEADERBOARD ================================================
// ============================================================================
// Backed by two Supabase tables under the user's own auth (RLS enforces who can
// read/write what — see the SQL in the v3.13 ship notes / report):
//   public_profiles(user_id pk, username, name, avatar small-jpeg, overall_mmr,
//                   beast_id, streak, updated_at)   — readable by any signed-in user
//   friendships(id, requester_id, addressee_id, status 'pending'|'accepted', created_at)
// Nothing here is stored in localStorage (besides the @handle, which already lives
// in reptilift_profile and syncs). Everything is fetched live and fully guarded so
// being offline / logged out / unconfigured NEVER throws or blanks the app.
// LOAD-ORDER NOTE: every function below is only called from event handlers, from
// switchTab, or from the onLogin/onLogout hooks — never from a top-level statement.

// short username validator: 3–20 chars, lowercase a-z 0-9 underscore.
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
function normalizeUsername(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

// Downscale a data-URL (or remote URL) avatar to a SMALL square JPEG for the public
// row. Reuses the canvas approach of downscaleImage() but takes a URL/dataURL source
// instead of a File. ~96px keeps the public blob tiny. Resolves "" on any failure so
// the leaderboard simply falls back to the 🦎 glyph.
function downscaleDataUrl(src, size, quality) {
  return new Promise((resolve) => {
    if (!src) return resolve("");
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = size; cv.height = size;
          const ctx = cv.getContext("2d");
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          resolve(cv.toDataURL("image/jpeg", quality));
        } catch (e) { resolve(""); }
      };
      img.onerror = () => resolve("");
      img.src = src;
    } catch (e) { resolve(""); }
  });
}

// ---- publishPublicProfile(): upsert MY public_profiles row -------------------
// Called on login (once a username is known), after a profile Save, and after
// finishWorkout. Debounced + guarded; no-op when logged out / no username / offline.
let publishTimer = null;
let lastPublishedAvatar = { src: null, small: "" };   // cache the costly downscale
function publishPublicProfile() {
  if (!supa || !cloudUser) return;
  if (!profile.username || !USERNAME_RE.test(profile.username)) return;   // need a valid handle
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => { publishTimer = null; doPublishPublicProfile(); }, 1200);
}
async function doPublishPublicProfile() {
  if (!supa || !cloudUser || !profile.username) return;
  try {
    // only re-downscale the avatar when it actually changed (it's expensive).
    let small = lastPublishedAvatar.small;
    if (profile.avatar !== lastPublishedAvatar.src) {
      small = await downscaleDataUrl(profile.avatar, 96, 0.6);
      lastPublishedAvatar = { src: profile.avatar, small };
    }
    const ob = (typeof overallBeast === "function") ? overallBeast() : null;
    // publish ONLY the socially-visible equipped cosmetics (frame + nameColor) — themes
    // and borders only matter on the owner's own screen/card, so keep the blob small.
    // Guarded; falls back to null so legacy rows / errors never break the upsert.
    let cosmetics = null;
    try {
      const fr = equippedCosmetic("frame"), nc = equippedCosmetic("nameColor");
      if (fr || nc) cosmetics = { frame: fr ? fr.id : null, nameColor: nc ? nc.id : null };
    } catch (e) {}
    const row = {
      user_id: cloudUser.id,
      username: profile.username,
      name: (profile.name || "").slice(0, 24),
      avatar: small || null,
      overall_mmr: (typeof overallMMR === "function" && overallMMR()) || 0,
      beast_id: ob ? ob.id : null,
      streak: (typeof computeStreak === "function" && computeStreak()) || 0,
      cosmetics: cosmetics,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supa.from("public_profiles").upsert(row, { onConflict: "user_id" });
    if (error) throw error;
  } catch (e) {
    // offline / RLS / unique-collision-on-old-handle — never crash; retries next call.
  }
  // my MMR just changed → sync it into any active duels I'm part of (guarded/debounced).
  try { if (typeof updateMyDuels === "function") updateMyDuels(); } catch (e) {}
}

// ---- onCloudAuthChanged(): called from onLogin / onLogout -------------------
// On login: if no username yet, prompt to claim one; otherwise publish + repaint.
// On logout: just repaint (locked state). The #friends-page may not be visible — we
// only repaint it if it's the active panel, but the username prompt fires regardless.
function onCloudAuthChanged() {
  if (cloudUser) {
    if (!profile.username || !USERNAME_RE.test(profile.username)) {
      // give the login/sync flow a beat to settle, then nudge for a handle.
      setTimeout(() => { try { openUsernameModal(); } catch (e) {} }, 600);
    } else {
      publishPublicProfile();
    }
  }
  const fp = document.getElementById("friends-page");
  if (fp && fp.classList.contains("active")) { try { renderFriendsPage(); } catch (e) {} }
  // keep the @handle visible on the profile header fresh too.
  const pp = document.getElementById("profile-page");
  if (pp && pp.classList.contains("active") && typeof renderProfile === "function") {
    try { renderProfile(); } catch (e) {}
  }
}

// ===== username claim modal =================================================
const unModal = document.getElementById("usernameModal");
const unInput = document.getElementById("unInput");
const unErr = document.getElementById("unErr");
const unSaveBtn = document.getElementById("unSave");
const unCancelBtn = document.getElementById("unCancel");
const unTitle = unModal ? unModal.querySelector(".un-title") : null;

// forceFlow=true means the user explicitly chose "Change handle" (cancel allowed
// either way; we never block the app on this).
function openUsernameModal() {
  if (!unModal) return;
  if (unInput) unInput.value = profile.username || "";
  if (unErr) unErr.textContent = "";
  if (unTitle) unTitle.textContent = profile.username ? "Change your @handle" : "Choose your @handle";
  unModal.classList.remove("hidden");
  setTimeout(() => { if (unInput) unInput.focus(); }, 50);
}
function closeUsernameModal() { if (unModal) unModal.classList.add("hidden"); }

async function submitUsername() {
  if (!supa || !cloudUser) { closeUsernameModal(); return; }
  const val = normalizeUsername(unInput ? unInput.value : "");
  if (!USERNAME_RE.test(val)) {
    if (unErr) unErr.textContent = "3–20 chars: lowercase letters, numbers, underscores.";
    return;
  }
  if (unSaveBtn) { unSaveBtn.disabled = true; unSaveBtn.textContent = "…"; }
  if (unErr) unErr.textContent = "";
  try {
    // attempt the claim by upserting our row with the chosen handle. The unique index
    // on lower(username) rejects a taken handle with a 23505 unique-violation.
    const ob = (typeof overallBeast === "function") ? overallBeast() : null;
    let small = lastPublishedAvatar.small;
    if (profile.avatar !== lastPublishedAvatar.src) {
      small = await downscaleDataUrl(profile.avatar, 96, 0.6);
      lastPublishedAvatar = { src: profile.avatar, small };
    }
    const { error } = await supa.from("public_profiles").upsert({
      user_id: cloudUser.id,
      username: val,
      name: (profile.name || "").slice(0, 24),
      avatar: small || null,
      overall_mmr: (typeof overallMMR === "function" && overallMMR()) || 0,
      beast_id: ob ? ob.id : null,
      streak: (typeof computeStreak === "function" && computeStreak()) || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) {
      if (error.code === "23505" || /duplicate|unique/i.test(error.message || "")) {
        if (unErr) unErr.textContent = "that handle is taken — try another";
      } else {
        if (unErr) unErr.textContent = (error.message || "Couldn't save that. Try again.");
      }
      return;
    }
    // success — persist locally (auto-syncs inside reptilift_profile) + repaint.
    profile.username = val;
    save();
    closeUsernameModal();
    if (typeof renderProfile === "function") { try { renderProfile(); } catch (e) {} }
    const fp = document.getElementById("friends-page");
    if (fp && fp.classList.contains("active")) { try { renderFriendsPage(); } catch (e) {} }
    if (soundOn) { try { blip(); } catch (e) {} }
  } catch (e) {
    if (unErr) unErr.textContent = "Network error — check your connection.";
  } finally {
    if (unSaveBtn) { unSaveBtn.disabled = false; unSaveBtn.textContent = "Claim handle"; }
  }
}
if (unSaveBtn) unSaveBtn.addEventListener("click", submitUsername);
if (unCancelBtn) unCancelBtn.addEventListener("click", closeUsernameModal);
if (unInput) unInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitUsername(); } });
if (unModal) unModal.addEventListener("click", (e) => { if (e.target === unModal) closeUsernameModal(); });

// ===== friends page state + rendering =======================================
let frActiveTab = "friends";       // friends | requests | board
let frBoardMode = "friends";       // friends | global (leaderboard toggle)
let frBusy = false;                // simple in-flight guard for mutating actions

// small avatar markup from a public_profiles row (img or 🦎 fallback).
function frAvatar(p) {
  return p && p.avatar ? `<img src="${p.avatar}" alt="" />` : "🦎";
}
function beastEmojiFor(beastId) {
  const b = beastId ? byId(beastId) : null;
  return b ? b.emoji : "🥚";
}

// Entry point — called from switchTab("friends-page") and after auth changes.
function renderFriendsPage() {
  const locked = document.getElementById("frLocked");
  const main = document.getElementById("frMain");
  const lockMsg = document.getElementById("frLockedMsg");
  if (!locked || !main) return;

  if (!CLOUD_CONFIGURED || !supa) {
    locked.classList.remove("hidden"); main.classList.add("hidden");
    if (lockMsg) lockMsg.textContent = "Cloud sync isn't set up, so friends & the leaderboard are offline.";
    return;
  }
  if (!cloudUser) {
    locked.classList.remove("hidden"); main.classList.add("hidden");
    if (lockMsg) lockMsg.textContent = "Sign in to add friends and climb the leaderboard.";
    return;
  }
  locked.classList.add("hidden"); main.classList.remove("hidden");

  // your handle line — prompt to claim if missing.
  const me = document.getElementById("frMe");
  if (me) {
    if (profile.username && USERNAME_RE.test(profile.username)) {
      const meFr = frameStyleCss(equippedCosmetic("frame"));
      const meNc = nameColorCss(equippedCosmetic("nameColor"));
      me.innerHTML = `<span class="fr-me-av"${meFr ? ` style="${meFr}"` : ""}>${avatarInner()}</span>
        <span class="fr-me-info"><b${meNc ? ` style="${meNc}"` : ""}>${escapeHtml(profile.name || "You")}</b>
        <span class="fr-me-handle">@${escapeHtml(profile.username)}</span></span>
        <button class="fr-me-edit" id="frEditHandle" type="button">change</button>`;
      const eh = document.getElementById("frEditHandle");
      if (eh) eh.addEventListener("click", () => openUsernameModal());
    } else {
      me.innerHTML = `<span class="fr-me-av">🦎</span>
        <span class="fr-me-info"><b>No handle yet</b>
        <span class="fr-me-handle">friends find you by @username</span></span>
        <button class="fr-me-edit gold" id="frClaimHandle" type="button">claim</button>`;
      const ch = document.getElementById("frClaimHandle");
      if (ch) ch.addEventListener("click", () => openUsernameModal());
    }
  }

  // reflect the active sub-tab
  document.querySelectorAll(".fr-tab").forEach((t) => t.classList.toggle("active", t.dataset.frtab === frActiveTab));
  document.querySelectorAll(".fr-sub").forEach((s) => s.classList.toggle("active", s.dataset.frpanel === frActiveTab));

  if (frActiveTab === "friends") loadFriendsList();
  else if (frActiveTab === "requests") loadRequests();
  else if (frActiveTab === "duels") loadDuels();
  else if (frActiveTab === "board") loadBoard();

  refreshRequestBadge();   // always keep the badge count fresh
  refreshDuelBadge();      // incoming-duels count badge
}

// ---- data helpers (all guarded, return [] on failure) ----------------------
// fetch every friendship edge touching me (either side).
async function fetchMyEdges() {
  if (!supa || !cloudUser) return [];
  try {
    const { data, error } = await supa
      .from("friendships")
      .select("id, requester_id, addressee_id, status, created_at")
      .or(`requester_id.eq.${cloudUser.id},addressee_id.eq.${cloudUser.id}`);
    if (error) throw error;
    return data || [];
  } catch (e) { return []; }
}
// fetch public_profiles for a set of user_ids → map keyed by user_id.
async function fetchProfiles(ids) {
  const out = {};
  const list = (ids || []).filter(Boolean);
  if (!supa || !list.length) return out;
  try {
    const { data, error } = await supa
      .from("public_profiles")
      .select("user_id, username, name, avatar, overall_mmr, beast_id, streak, cosmetics")
      .in("user_id", list);
    if (error) throw error;
    (data || []).forEach((p) => { out[p.user_id] = p; });
    return out;
  } catch (e) { return out; }
}

// ---- FRIENDS LIST ----------------------------------------------------------
async function loadFriendsList() {
  const box = document.getElementById("frFriendsList");
  if (!box) return;
  box.innerHTML = `<div class="fr-empty">Loading…</div>`;
  const edges = await fetchMyEdges();
  const accepted = edges.filter((e) => e.status === "accepted");
  const friendIds = accepted.map((e) => e.requester_id === cloudUser.id ? e.addressee_id : e.requester_id);
  if (!friendIds.length) {
    box.innerHTML = `<div class="fr-empty">No friends yet. Add someone by their @username above. 🦎</div>`;
    return;
  }
  const profs = await fetchProfiles(friendIds);
  const rows = friendIds
    .map((id) => ({ id, p: profs[id] }))
    .sort((a, b) => ((b.p && b.p.overall_mmr) || 0) - ((a.p && a.p.overall_mmr) || 0));
  box.innerHTML = rows.map(({ id, p }) => {
    const name = (p && (p.name || p.username)) || "Lifter";
    const handle = p && p.username ? `@${p.username}` : "";
    const mmr = (p && p.overall_mmr) || 0;
    const cos = rowCosmetics(p);
    const frStyle = frameStyleCss(cos.frame);
    const ncStyle = nameColorCss(cos.nameColor);
    return `<button class="fr-card" data-friend="${id}" type="button">
      <span class="fr-card-av"${frStyle ? ` style="${frStyle}"` : ""}>${frAvatar(p)}</span>
      <span class="fr-card-main">
        <span class="fr-card-name"${ncStyle ? ` style="${ncStyle}"` : ""}>${escapeHtml(name)}</span>
        <span class="fr-card-handle">${escapeHtml(handle)}</span>
      </span>
      <span class="fr-card-rank">${beastEmojiFor(p && p.beast_id)} <b>${mmr.toLocaleString()}</b></span>
    </button>`;
  }).join("");
  box.querySelectorAll("[data-friend]").forEach((el) => {
    el.addEventListener("click", () => openFriendModal(el.dataset.friend, profs[el.dataset.friend]));
  });
}

// ---- ADD FRIEND ------------------------------------------------------------
async function addFriendByUsername(raw) {
  const msg = document.getElementById("frAddMsg");
  const setMsg = (t, ok) => { if (msg) { msg.textContent = t; msg.className = "fr-msg" + (ok ? " ok" : t ? " err" : ""); } };
  const uname = normalizeUsername(raw);
  if (!uname || uname.length < 3) { setMsg("Enter a valid @username (3+ chars)."); return; }
  if (uname === profile.username) { setMsg("That's you! 🦎"); return; }
  if (frBusy) return;
  frBusy = true; setMsg("Looking up @" + uname + "…", true);
  try {
    // 1) resolve the target user_id by handle.
    const { data: target, error: lookErr } = await supa
      .from("public_profiles").select("user_id, username").eq("username", uname).maybeSingle();
    if (lookErr) throw lookErr;
    if (!target) { setMsg("No lifter found with that handle."); return; }
    if (target.user_id === cloudUser.id) { setMsg("That's you! 🦎"); return; }

    // 2) inspect any existing edge between us.
    const edges = await fetchMyEdges();
    const existing = edges.find((e) =>
      (e.requester_id === cloudUser.id && e.addressee_id === target.user_id) ||
      (e.addressee_id === cloudUser.id && e.requester_id === target.user_id));
    if (existing) {
      if (existing.status === "accepted") { setMsg("You're already friends. 🤝", true); return; }
      if (existing.requester_id === cloudUser.id) { setMsg("Request already sent — waiting on them."); return; }
      // they already requested ME → accept it instead of a duplicate request.
      const { error: accErr } = await supa.from("friendships").update({ status: "accepted" }).eq("id", existing.id);
      if (accErr) throw accErr;
      setMsg("They'd already requested you — you're now friends! 🤝", true);
      const inp = document.getElementById("frAddInput"); if (inp) inp.value = "";
      loadFriendsList(); refreshRequestBadge();
      return;
    }

    // 3) no edge → send a pending request.
    const { error: insErr } = await supa.from("friendships")
      .insert({ requester_id: cloudUser.id, addressee_id: target.user_id, status: "pending" });
    if (insErr) {
      if (insErr.code === "23505") { setMsg("Request already exists."); return; }
      throw insErr;
    }
    setMsg("Request sent to @" + uname + " ✓", true);
    const inp = document.getElementById("frAddInput"); if (inp) inp.value = "";
    refreshRequestBadge();
  } catch (e) {
    setMsg("Couldn't send that request — try again.");
  } finally { frBusy = false; }
}

// ---- REQUESTS (incoming + outgoing pending) --------------------------------
async function loadRequests() {
  const inBox = document.getElementById("frIncoming");
  const outBox = document.getElementById("frOutgoing");
  if (inBox) inBox.innerHTML = `<div class="fr-empty">Loading…</div>`;
  if (outBox) outBox.innerHTML = "";
  const edges = await fetchMyEdges();
  const incoming = edges.filter((e) => e.status === "pending" && e.addressee_id === cloudUser.id);
  const outgoing = edges.filter((e) => e.status === "pending" && e.requester_id === cloudUser.id);
  const ids = [...incoming.map((e) => e.requester_id), ...outgoing.map((e) => e.addressee_id)];
  const profs = await fetchProfiles(ids);

  if (inBox) {
    inBox.innerHTML = incoming.length ? incoming.map((e) => {
      const p = profs[e.requester_id];
      return reqRowHtml(e.id, p, e.requester_id, "incoming");
    }).join("") : `<div class="fr-empty">No incoming requests.</div>`;
    inBox.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", () => acceptRequest(b.dataset.accept)));
    inBox.querySelectorAll("[data-decline]").forEach((b) => b.addEventListener("click", () => deleteEdge(b.dataset.decline, "decline")));
  }
  if (outBox) {
    outBox.innerHTML = outgoing.length ? outgoing.map((e) => {
      const p = profs[e.addressee_id];
      return reqRowHtml(e.id, p, e.addressee_id, "outgoing");
    }).join("") : `<div class="fr-empty">No outgoing requests.</div>`;
    outBox.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => deleteEdge(b.dataset.cancel, "cancel")));
  }
  refreshRequestBadge();
}
function reqRowHtml(edgeId, p, uid, dir) {
  const name = (p && (p.name || p.username)) || "Lifter";
  const handle = p && p.username ? `@${p.username}` : "";
  const actions = dir === "incoming"
    ? `<span class="fr-reqbtns">
         <button class="fr-mini ok" data-accept="${edgeId}" type="button">Accept</button>
         <button class="fr-mini" data-decline="${edgeId}" type="button">Decline</button>
       </span>`
    : `<span class="fr-reqbtns">
         <button class="fr-mini" data-cancel="${edgeId}" type="button">Cancel</button>
       </span>`;
  return `<div class="fr-card req">
    <span class="fr-card-av">${frAvatar(p)}</span>
    <span class="fr-card-main">
      <span class="fr-card-name">${escapeHtml(name)}</span>
      <span class="fr-card-handle">${escapeHtml(handle)}</span>
    </span>
    ${actions}
  </div>`;
}
async function acceptRequest(edgeId) {
  if (frBusy) return; frBusy = true;
  try {
    const { error } = await supa.from("friendships").update({ status: "accepted" }).eq("id", edgeId);
    if (error) throw error;
    if (soundOn) { try { blip(); } catch (e) {} }
  } catch (e) {}
  finally { frBusy = false; }
  loadRequests();
}
// shared delete for decline (incoming) / cancel (outgoing) / unfriend (accepted).
async function deleteEdge(edgeId, kind) {
  if (frBusy) return; frBusy = true;
  try {
    const { error } = await supa.from("friendships").delete().eq("id", edgeId);
    if (error) throw error;
  } catch (e) {}
  finally { frBusy = false; }
  if (kind === "unfriend") { closeFriendModal(); loadFriendsList(); }
  else loadRequests();
}

// keep the Requests sub-tab badge count in sync (incoming pending only).
async function refreshRequestBadge() {
  const badge = document.getElementById("frReqBadge");
  if (!badge || !supa || !cloudUser) return;
  try {
    const { count, error } = await supa.from("friendships")
      .select("id", { count: "exact", head: true })
      .eq("addressee_id", cloudUser.id).eq("status", "pending");
    if (error) throw error;
    if (count && count > 0) { badge.textContent = count; badge.classList.remove("hidden"); }
    else badge.classList.add("hidden");
  } catch (e) { badge.classList.add("hidden"); }
}

// ---- LEADERBOARD -----------------------------------------------------------
function loadBoard() {
  document.querySelectorAll(".fr-bt").forEach((b) => b.classList.toggle("active", b.dataset.board === frBoardMode));
  if (frBoardMode === "global") loadGlobalBoard();
  else loadFriendsBoard();
}
function boardRowHtml(pos, p, isMe) {
  const name = (p && (p.name || p.username)) || "Lifter";
  const handle = p && p.username ? `@${p.username}` : "";
  const mmr = (p && p.overall_mmr) || 0;
  const medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
  // cosmetics: my own row uses live local equips (published data may lag); friend/global
  // rows use the small published cosmetics blob. Both guarded so null rows render plainly.
  const cos = isMe
    ? { frame: equippedCosmetic("frame"), nameColor: equippedCosmetic("nameColor") }
    : rowCosmetics(p);
  const frStyle = frameStyleCss(cos.frame);
  const ncStyle = nameColorCss(cos.nameColor);
  return `<div class="lb-row${isMe ? " me" : ""}">
    <span class="lb-pos">${medal || pos}</span>
    <span class="lb-av"${frStyle ? ` style="${frStyle}"` : ""}>${frAvatar(p)}</span>
    <span class="lb-main">
      <span class="lb-name"${ncStyle ? ` style="${ncStyle}"` : ""}>${escapeHtml(name)}${isMe ? " <small>(you)</small>" : ""}</span>
      <span class="lb-handle">${escapeHtml(handle)}</span>
    </span>
    <span class="lb-rank">${beastEmojiFor(p && p.beast_id)} <b>${mmr.toLocaleString()}</b></span>
  </div>`;
}
// FRIENDS board = you + accepted friends, ranked by overall_mmr desc.
async function loadFriendsBoard() {
  const box = document.getElementById("frBoard");
  if (!box) return;
  box.innerHTML = `<div class="fr-empty">Loading…</div>`;
  const edges = await fetchMyEdges();
  const accepted = edges.filter((e) => e.status === "accepted");
  const ids = accepted.map((e) => e.requester_id === cloudUser.id ? e.addressee_id : e.requester_id);
  ids.push(cloudUser.id);
  const profs = await fetchProfiles(ids);
  // ensure MY row exists even if not yet published (use live local stats as fallback).
  if (!profs[cloudUser.id]) {
    const ob = (typeof overallBeast === "function") ? overallBeast() : null;
    profs[cloudUser.id] = {
      user_id: cloudUser.id, username: profile.username, name: profile.name,
      avatar: profile.avatar, overall_mmr: (overallMMR && overallMMR()) || 0,
      beast_id: ob ? ob.id : null,
    };
  }
  const rows = Object.values(profs).sort((a, b) => (b.overall_mmr || 0) - (a.overall_mmr || 0));
  box.innerHTML = rows.map((p, i) => boardRowHtml(i + 1, p, p.user_id === cloudUser.id)).join("")
    || `<div class="fr-empty">Add friends to build your leaderboard. 🦎</div>`;
}
// GLOBAL board = top ~50 public_profiles by overall_mmr desc, + my own rank.
async function loadGlobalBoard() {
  const box = document.getElementById("frBoard");
  if (!box) return;
  box.innerHTML = `<div class="fr-empty">Loading…</div>`;
  try {
    const { data, error } = await supa
      .from("public_profiles")
      .select("user_id, username, name, avatar, overall_mmr, beast_id, streak, cosmetics")
      .order("overall_mmr", { ascending: false })
      .limit(50);
    if (error) throw error;
    const list = data || [];
    let html = list.map((p, i) => boardRowHtml(i + 1, p, p.user_id === cloudUser.id)).join("");
    const inTop = list.some((p) => p.user_id === cloudUser.id);
    if (!inTop) {
      // compute my global rank = (# of profiles with a strictly higher MMR) + 1.
      const myMmr = (overallMMR && overallMMR()) || 0;
      let myRank = null;
      try {
        const { count } = await supa.from("public_profiles")
          .select("user_id", { count: "exact", head: true })
          .gt("overall_mmr", myMmr);
        if (typeof count === "number") myRank = count + 1;
      } catch (e) {}
      const ob = (typeof overallBeast === "function") ? overallBeast() : null;
      const meP = { username: profile.username, name: profile.name, avatar: profile.avatar,
        overall_mmr: myMmr, beast_id: ob ? ob.id : null };
      html += `<div class="lb-divider">your rank</div>` + boardRowHtml(myRank || "—", meP, true);
    }
    box.innerHTML = html || `<div class="fr-empty">No public profiles yet — be the first! 🦎</div>`;
  } catch (e) {
    box.innerHTML = `<div class="fr-empty">Couldn't load the leaderboard. Try again.</div>`;
  }
}

// ---- read-only friend profile modal ----------------------------------------
const friendModal = document.getElementById("friendModal");
function openFriendModal(uid, p) {
  if (!friendModal) return;
  const card = document.getElementById("friendCard");
  const b = p && p.beast_id ? byId(p.beast_id) : null;
  const color = b ? b.color : "#5b6168";
  const name = (p && (p.name || p.username)) || "Lifter";
  const handle = p && p.username ? `@${p.username}` : "";
  const mmr = (p && p.overall_mmr) || 0;
  const streak = (p && p.streak) || 0;
  if (card) {
    card.style.setProperty("--c", color);
    card.innerHTML = `
      <div class="fp-av">${frAvatar(p)}</div>
      <div class="fp-name">${escapeHtml(name)}</div>
      ${handle ? `<div class="fp-handle">${escapeHtml(handle)}</div>` : ""}
      <div class="fp-rank">${b ? b.emoji + " " + escapeHtml(b.name) : "🥚 Unranked"}</div>
      <div class="fp-stats">
        <div class="fp-stat"><b>${mmr.toLocaleString()}</b><span>Overall MMR</span></div>
        <div class="fp-stat"><b>${streak.toLocaleString()}</b><span>day streak</span></div>
      </div>
      <button class="btn fp-challenge" id="fpChallenge" type="button">⚔️ Challenge</button>
      <button class="btn ghost fp-unfriend" id="fpUnfriend" type="button">Unfriend</button>`;
    const ch = document.getElementById("fpChallenge");
    if (ch) ch.addEventListener("click", () => {
      closeFriendModal();
      openDuelModal({ id: uid, name: (p && (p.name || p.username)) || "Lifter", username: p && p.username });
    });
    const uf = document.getElementById("fpUnfriend");
    if (uf) uf.addEventListener("click", () => unfriend(uid));
  }
  friendModal.classList.remove("hidden");
}
function closeFriendModal() { if (friendModal) friendModal.classList.add("hidden"); }
async function unfriend(uid) {
  if (!confirm("Remove this friend?")) return;
  const edges = await fetchMyEdges();
  const edge = edges.find((e) => e.status === "accepted" &&
    (e.requester_id === uid || e.addressee_id === uid));
  if (edge) deleteEdge(edge.id, "unfriend");
  else { closeFriendModal(); loadFriendsList(); }
}
const friendCloseBtn = document.getElementById("friendClose");
if (friendCloseBtn) friendCloseBtn.addEventListener("click", closeFriendModal);
if (friendModal) friendModal.addEventListener("click", (e) => { if (e.target === friendModal) closeFriendModal(); });

// ============================================================================
// ===== FRIEND DUELS (challenges) ============================================
// ============================================================================
// A duel = two friends race to GAIN the most MMR on a chosen lift (or Overall)
// before a deadline. Improvement-based, so absolute strength never matters.
// Backed by one Supabase table `challenges` under the user's own auth (RLS limits
// rows to participants). Everything is fetched live — NO new localStorage keys.
// Self-reported caveat: the UPDATE policy lets either participant write the row,
// so each side's *_current MMR is client-self-reported and trusted (fine for a
// fun feature). Resolution is client-side: whoever loads a past-deadline active
// duel finalizes it (guarded against double-resolve).
// LOAD-ORDER NOTE: every function here is only called from event handlers,
// switchTab, the finishWorkout/publish hooks, or renderFriendsPage — never from a
// top-level statement.

const DUEL_STATUSES_LIVE = ["pending", "active"];

// my current MMR for a duel's exercise: 'overall' → overallMMR(), else best per-lift.
function duelMyMmr(exId) {
  try {
    if (exId === "overall") return (overallMMR && overallMMR()) || 0;
    const rec = bests[exId];
    return (rec && typeof rec.mmr === "number") ? rec.mmr : 0;
  } catch (e) { return 0; }
}

// fetch every challenge row touching me (RLS already restricts to participant rows).
async function fetchMyDuels() {
  if (!supa || !cloudUser) return [];
  try {
    const { data, error } = await supa
      .from("challenges")
      .select("*")
      .or(`challenger_id.eq.${cloudUser.id},opponent_id.eq.${cloudUser.id}`)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) { return []; }
}

// ---- CREATE DUEL modal -----------------------------------------------------
let duelModalDays = 7;            // selected duration (days)
let duelPrefillFriend = null;     // { id, name, username } when opened from a profile
let duelBusy = false;

function duelLiftOptions() {
  // 'Overall MMR' first, then every exercise grouped subtly by name. Reuse EXERCISES().
  let html = `<option value="overall">⭐ Overall MMR</option>`;
  try {
    EXERCISES().forEach((e) => {
      html += `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`;
    });
  } catch (e) {}
  return html;
}

async function openDuelModal(prefill) {
  const modal = document.getElementById("duelModal");
  if (!modal) return;
  if (!supa || !cloudUser) return;     // can't duel logged out — button is gated anyway
  duelPrefillFriend = prefill || null;
  duelModalDays = 7;
  const err = document.getElementById("duelErr");
  if (err) err.textContent = "";
  const liftSel = document.getElementById("duelLift");
  if (liftSel) liftSel.innerHTML = duelLiftOptions();
  document.querySelectorAll("#duelDurRow .duel-dur").forEach((b) =>
    b.classList.toggle("active", b.dataset.days === "7"));

  // populate opponent dropdown from accepted friends.
  const oppSel = document.getElementById("duelOpp");
  if (oppSel) {
    oppSel.innerHTML = `<option value="">Loading friends…</option>`;
    const edges = await fetchMyEdges();
    const accepted = edges.filter((e) => e.status === "accepted");
    const ids = accepted.map((e) => e.requester_id === cloudUser.id ? e.addressee_id : e.requester_id);
    if (!ids.length) {
      oppSel.innerHTML = `<option value="">No friends yet</option>`;
    } else {
      const profs = await fetchProfiles(ids);
      oppSel.innerHTML = ids.map((id) => {
        const p = profs[id];
        const label = (p && (p.name || p.username)) || "Lifter";
        const h = p && p.username ? ` @${p.username}` : "";
        return `<option value="${id}" data-name="${escapeHtml((p && (p.name || p.username)) || "Lifter")}" data-un="${escapeHtml((p && p.username) || "")}">${escapeHtml(label)}${escapeHtml(h)}</option>`;
      }).join("");
      if (duelPrefillFriend && ids.includes(duelPrefillFriend.id)) oppSel.value = duelPrefillFriend.id;
    }
  }
  modal.classList.remove("hidden");
}
function closeDuelModal() {
  const modal = document.getElementById("duelModal");
  if (modal) modal.classList.add("hidden");
}

async function submitDuel() {
  if (duelBusy) return;
  const err = document.getElementById("duelErr");
  const setErr = (t) => { if (err) err.textContent = t || ""; };
  const oppSel = document.getElementById("duelOpp");
  const liftSel = document.getElementById("duelLift");
  if (!oppSel || !liftSel) return;
  const oppId = oppSel.value;
  if (!oppId) { setErr("Add a friend first to challenge them."); return; }
  const opt = oppSel.options[oppSel.selectedIndex];
  const oppName = (opt && opt.dataset.name) || "Lifter";
  const exId = liftSel.value || "overall";
  let exName = "Overall MMR";
  if (exId !== "overall") { const ex = exById(exId); exName = ex ? ex.name : exId; }

  if (!supa || !cloudUser) { setErr("Sign in to start a duel."); return; }
  duelBusy = true;
  const sendBtn = document.getElementById("duelSend");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "…"; }
  try {
    // block a duplicate live (pending/active) duel with this friend on this same lift.
    const mine = await fetchMyDuels();
    const dup = mine.find((d) => DUEL_STATUSES_LIVE.includes(d.status) && d.exercise_id === exId &&
      ((d.challenger_id === cloudUser.id && d.opponent_id === oppId) ||
       (d.opponent_id === cloudUser.id && d.challenger_id === oppId)));
    if (dup) { setErr("You already have an active duel with them on this lift."); return; }

    const myMmr = duelMyMmr(exId);
    const deadline = new Date(Date.now() + duelModalDays * 864e5).toISOString();
    const myName = (profile.name || profile.username || "You").slice(0, 24);
    const { error } = await supa.from("challenges").insert({
      challenger_id: cloudUser.id,
      opponent_id: oppId,
      exercise_id: exId,
      exercise_name: exName,
      challenger_name: myName,
      opponent_name: oppName,
      status: "pending",
      deadline: deadline,
      challenger_start: myMmr,
      challenger_current: myMmr,
    });
    if (error) throw error;
    if (soundOn) { try { blip(); } catch (e) {} }
    closeDuelModal();
    frActiveTab = "duels";
    renderFriendsPage();
  } catch (e) {
    setErr("Couldn't send that challenge — try again.");
  } finally {
    duelBusy = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = "Send challenge ⚔️"; }
  }
}

// ---- updateMyDuels(): sync MY current MMR into each active duel I'm in -------
// Recompute my side's current MMR locally and UPDATE only if it changed. Debounced
// + guarded; safe to call from finishWorkout / publish / opening the Duels tab.
let updateDuelsTimer = null;
let updatingDuels = false;
function updateMyDuels() {
  if (!supa || !cloudUser) return;
  clearTimeout(updateDuelsTimer);
  updateDuelsTimer = setTimeout(() => { updateDuelsTimer = null; doUpdateMyDuels(); }, 900);
}
async function doUpdateMyDuels() {
  if (!supa || !cloudUser || updatingDuels) return;
  updatingDuels = true;
  try {
    const mine = await fetchMyDuels();
    const active = mine.filter((d) => d.status === "active");
    for (const d of active) {
      const mineIsChallenger = d.challenger_id === cloudUser.id;
      const cur = duelMyMmr(d.exercise_id);
      const stored = mineIsChallenger ? d.challenger_current : d.opponent_current;
      if (cur === stored) continue;
      const patch = mineIsChallenger ? { challenger_current: cur } : { opponent_current: cur };
      try { await supa.from("challenges").update(patch).eq("id", d.id); } catch (e) {}
    }
  } catch (e) {} finally { updatingDuels = false; }
}

// ---- resolve a past-deadline active duel client-side (idempotent) ----------
// Whoever views it finalizes: winner = the higher gain, null on tie. Guarded so a
// double-resolve never fires (only update if still 'active'); returns the patched row.
async function resolveDuel(d) {
  try {
    const cGain = (d.challenger_current || 0) - (d.challenger_start || 0);
    const oGain = (d.opponent_current || 0) - (d.opponent_start || 0);
    let winner = null;
    if (cGain > oGain) winner = d.challenger_id;
    else if (oGain > cGain) winner = d.opponent_id;
    const { data, error } = await supa.from("challenges")
      .update({ status: "completed", winner_id: winner })
      .eq("id", d.id).eq("status", "active").select();
    if (error) throw error;
    const row = (data && data[0]) || null;
    // celebratory toast only if *I* won and this client actually performed the update.
    if (row && winner === cloudUser.id) { try { queueDuelWinToast(row); } catch (e) {} }
    return row || { ...d, status: "completed", winner_id: winner };
  } catch (e) { return { ...d, status: "completed" }; }
}

// ---- DUELS tab render ------------------------------------------------------
async function loadDuels() {
  const box = document.getElementById("duelBody");
  if (!box) return;
  if (!supa || !cloudUser) {
    box.innerHTML = `<div class="fr-empty">Sign in to duel your friends. 🦎</div>`;
    return;
  }
  box.innerHTML = `<div class="fr-empty">Loading duels…</div>`;
  // sync my own progress first, then fetch a fresh snapshot.
  try { await doUpdateMyDuels(); } catch (e) {}
  let duels = await fetchMyDuels();

  // resolve any active duels whose deadline has passed (idempotent / guarded).
  const now = Date.now();
  for (let i = 0; i < duels.length; i++) {
    const d = duels[i];
    if (d.status === "active" && d.deadline && new Date(d.deadline).getTime() <= now) {
      duels[i] = await resolveDuel(d);
    }
  }

  const incoming = duels.filter((d) => d.status === "pending" && d.opponent_id === cloudUser.id);
  const outgoing = duels.filter((d) => d.status === "pending" && d.challenger_id === cloudUser.id);
  const active = duels.filter((d) => d.status === "active");
  const done = duels.filter((d) => d.status === "completed").slice(0, 12);

  let html = "";
  if (incoming.length) {
    html += `<h3 class="sub">⚔️ Incoming challenges</h3>` +
      incoming.map((d) => duelPendingCard(d, "incoming")).join("");
  }
  if (active.length) {
    html += `<h3 class="sub">🔥 Active duels</h3>` + active.map(duelActiveCard).join("");
  }
  if (outgoing.length) {
    html += `<h3 class="sub">⏳ Waiting on them</h3>` +
      outgoing.map((d) => duelPendingCard(d, "outgoing")).join("");
  }
  if (done.length) {
    html += `<h3 class="sub">🏁 Past duels</h3>` + done.map(duelDoneCard).join("");
  }
  if (!html) {
    html = `<div class="fr-empty">No duels yet. Hit <b>New duel</b> to challenge a friend — most MMR gained wins. ⚔️</div>`;
  }
  box.innerHTML = html;

  // wire actions
  box.querySelectorAll("[data-accept-duel]").forEach((b) =>
    b.addEventListener("click", () => acceptDuel(b.dataset.acceptDuel)));
  box.querySelectorAll("[data-decline-duel]").forEach((b) =>
    b.addEventListener("click", () => declineDuel(b.dataset.declineDuel)));
  box.querySelectorAll("[data-cancel-duel]").forEach((b) =>
    b.addEventListener("click", () => cancelDuel(b.dataset.cancelDuel)));

  refreshDuelBadge();
}

// who am I in this duel? returns { mine, theirs } normalized sides.
function duelSides(d) {
  const iAmCh = d.challenger_id === cloudUser.id;
  return {
    iAmChallenger: iAmCh,
    myName: iAmCh ? d.challenger_name : d.opponent_name,
    theirName: iAmCh ? d.opponent_name : d.challenger_name,
    myGain: (iAmCh ? (d.challenger_current || 0) - (d.challenger_start || 0)
                   : (d.opponent_current || 0) - (d.opponent_start || 0)),
    theirGain: (iAmCh ? (d.opponent_current || 0) - (d.opponent_start || 0)
                      : (d.challenger_current || 0) - (d.challenger_start || 0)),
  };
}
function gainStr(g) { return (g > 0 ? "+" : "") + (g || 0).toLocaleString(); }
function timeLeftStr(deadline) {
  if (!deadline) return "";
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return "ended";
  const d = Math.floor(ms / 864e5);
  if (d >= 1) return d + (d === 1 ? " day left" : " days left");
  const h = Math.floor(ms / 36e5);
  if (h >= 1) return h + (h === 1 ? " hour left" : " hours left");
  const m = Math.max(1, Math.floor(ms / 6e4));
  return m + (m === 1 ? " min left" : " mins left");
}

function duelPendingCard(d, dir) {
  const s = duelSides(d);
  const who = dir === "incoming" ? s.theirName : s.theirName;
  const actions = dir === "incoming"
    ? `<div class="duel-acts">
         <button class="fr-mini ok" data-accept-duel="${d.id}" type="button">Accept</button>
         <button class="fr-mini" data-decline-duel="${d.id}" type="button">Decline</button>
       </div>`
    : `<div class="duel-acts">
         <span class="duel-waiting">waiting…</span>
         <button class="fr-mini" data-cancel-duel="${d.id}" type="button">Cancel</button>
       </div>`;
  const verb = dir === "incoming" ? "challenged you" : "you challenged";
  return `<div class="duel-row pending">
    <div class="duel-row-head">
      <span class="duel-lift">${escapeHtml(d.exercise_name || "Overall MMR")}</span>
      <span class="duel-time">${escapeHtml(timeLeftStr(d.deadline))}</span>
    </div>
    <div class="duel-pending-line"><b>${escapeHtml(who)}</b> — ${verb}</div>
    ${actions}
  </div>`;
}

function duelActiveCard(d) {
  const s = duelSides(d);
  const meLead = s.myGain > s.theirGain;
  const theyLead = s.theirGain > s.myGain;
  const tie = s.myGain === s.theirGain;
  const lead = tie ? `<span class="duel-lead tie">tied</span>`
    : meLead ? `<span class="duel-lead me">you lead</span>`
    : `<span class="duel-lead them">they lead</span>`;
  return `<div class="duel-row active">
    <div class="duel-row-head">
      <span class="duel-lift">${escapeHtml(d.exercise_name || "Overall MMR")}</span>
      <span class="duel-time">⏳ ${escapeHtml(timeLeftStr(d.deadline))}</span>
    </div>
    <div class="duel-vs">
      <div class="duel-side mine${meLead ? " winning" : ""}">
        <span class="duel-pname">${escapeHtml(s.myName || "You")}</span>
        <span class="duel-gain">${gainStr(s.myGain)}</span>
        <span class="duel-gainlbl">MMR gained</span>
      </div>
      <span class="duel-vs-x">VS</span>
      <div class="duel-side theirs${theyLead ? " winning" : ""}">
        <span class="duel-pname">${escapeHtml(s.theirName || "Rival")}</span>
        <span class="duel-gain">${gainStr(s.theirGain)}</span>
        <span class="duel-gainlbl">MMR gained</span>
      </div>
    </div>
    <div class="duel-foot">${lead}</div>
  </div>`;
}

function duelDoneCard(d) {
  const s = duelSides(d);
  let result, cls;
  if (!d.winner_id) { result = "TIE"; cls = "tie"; }
  else if (d.winner_id === cloudUser.id) { result = "WON"; cls = "won"; }
  else { result = "LOST"; cls = "lost"; }
  return `<div class="duel-row done ${cls}">
    <div class="duel-row-head">
      <span class="duel-lift">${escapeHtml(d.exercise_name || "Overall MMR")}</span>
      <span class="duel-result ${cls}">${result}</span>
    </div>
    <div class="duel-done-line">
      <span>${escapeHtml(s.myName || "You")} <b>${gainStr(s.myGain)}</b></span>
      <span class="duel-vs-mini">vs</span>
      <span>${escapeHtml(s.theirName || "Rival")} <b>${gainStr(s.theirGain)}</b></span>
    </div>
  </div>`;
}

// ---- duel mutations --------------------------------------------------------
async function acceptDuel(id) {
  if (duelBusy) return; duelBusy = true;
  try {
    // snapshot MY start = my current MMR for that lift right now.
    const mine = await fetchMyDuels();
    const d = mine.find((x) => x.id === id);
    if (d && d.opponent_id === cloudUser.id) {
      const myMmr = duelMyMmr(d.exercise_id);
      const { error } = await supa.from("challenges").update({
        status: "active", opponent_start: myMmr, opponent_current: myMmr,
      }).eq("id", id);
      if (error) throw error;
      if (soundOn) { try { blip(); } catch (e) {} }
    }
  } catch (e) {} finally { duelBusy = false; }
  loadDuels();
}
async function declineDuel(id) {
  if (duelBusy) return; duelBusy = true;
  try { await supa.from("challenges").update({ status: "declined" }).eq("id", id); } catch (e) {}
  finally { duelBusy = false; }
  loadDuels();
}
async function cancelDuel(id) {
  if (duelBusy) return; duelBusy = true;
  try { await supa.from("challenges").delete().eq("id", id); } catch (e) {}
  finally { duelBusy = false; }
  loadDuels();
}

// ---- incoming-duel count badge ---------------------------------------------
async function refreshDuelBadge() {
  const badge = document.getElementById("frDuelBadge");
  if (!badge || !supa || !cloudUser) return;
  try {
    const { count, error } = await supa.from("challenges")
      .select("id", { count: "exact", head: true })
      .eq("opponent_id", cloudUser.id).eq("status", "pending");
    if (error) throw error;
    if (count && count > 0) { badge.textContent = count; badge.classList.remove("hidden"); }
    else badge.classList.add("hidden");
  } catch (e) { badge.classList.add("hidden"); }
}

// ---- duel-win toast (reuses the achievement toast styling) -----------------
function queueDuelWinToast(d) {
  let el = document.getElementById("achToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "achToast";
    el.className = "achtoast";
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <span class="at-ic">⚔️</span>
    <span class="at-main">
      <span class="at-tag">🏆 Duel won</span>
      <span class="at-name">${escapeHtml(d.exercise_name || "Overall MMR")} <small>vs ${escapeHtml(d.challenger_id === cloudUser.id ? d.opponent_name : d.challenger_name)}</small></span>
    </span>`;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  if (soundOn) { try { playRankUpSfx(); } catch (e) {} buzz([20, 40, 20]); }
  const close = () => { el.classList.remove("show"); el.removeEventListener("click", close); };
  el.addEventListener("click", close);
  setTimeout(close, 3000);
}

// ===== friends-page event wiring (bottom, after all helpers are defined) =====
document.querySelectorAll(".fr-tab").forEach((t) => t.addEventListener("click", () => {
  frActiveTab = t.dataset.frtab; renderFriendsPage();
}));
// duel modal wiring
(function wireDuelModal() {
  const newBtn = document.getElementById("duelNewBtn");
  if (newBtn) newBtn.addEventListener("click", () => openDuelModal(null));
  const sendBtn = document.getElementById("duelSend");
  if (sendBtn) sendBtn.addEventListener("click", submitDuel);
  const cancelBtn = document.getElementById("duelCancel");
  if (cancelBtn) cancelBtn.addEventListener("click", closeDuelModal);
  const modal = document.getElementById("duelModal");
  if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeDuelModal(); });
  const durRow = document.getElementById("duelDurRow");
  if (durRow) durRow.addEventListener("click", (e) => {
    const b = e.target.closest(".duel-dur");
    if (!b) return;
    duelModalDays = parseInt(b.dataset.days, 10) || 7;
    durRow.querySelectorAll(".duel-dur").forEach((x) => x.classList.toggle("active", x === b));
  });
})();
document.querySelectorAll(".fr-bt").forEach((b) => b.addEventListener("click", () => {
  frBoardMode = b.dataset.board; loadBoard();
}));
(function wireAddFriend() {
  const btn = document.getElementById("frAddBtn");
  const inp = document.getElementById("frAddInput");
  if (btn && inp) {
    btn.addEventListener("click", () => addFriendByUsername(inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addFriendByUsername(inp.value); } });
  }
})();
