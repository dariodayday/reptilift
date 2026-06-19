// Reptilift v3.8 — earn your beast rank per exercise from your MMR.
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
  "reptilift_active", "reptilift_bests", "reptilift_bwlog", "reptilift_customex",
  "reptilift_inventory", "reptilift_lastsets", "reptilift_profile", "reptilift_quests",
  "reptilift_routines", "reptilift_sets", "reptilift_sound", "reptilift_streak",
  "reptilift_wallet", "reptilift_workouts",
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

function saveEconomy() {
  localStorage.setItem("reptilift_wallet", JSON.stringify(wallet));
  localStorage.setItem("reptilift_inventory", JSON.stringify(inventory));
  localStorage.setItem("reptilift_quests", JSON.stringify(quests));
  localStorage.setItem("reptilift_streak", JSON.stringify(streakx));
}
const COIN = "🦎";                            // currency glyph (reptile scales)
const CUR = "Scales";                         // currency name
const addCoins = (n) => { wallet.balance = Math.max(0, wallet.balance + n); };
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
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
document.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.go)));

// ===== profile bodyweight =====
const bwInput = document.getElementById("bw");
if (profile.bodyweight) bwInput.value = profile.bodyweight;
bwInput.addEventListener("change", () => {
  profile.bodyweight = parseInt(bwInput.value, 10) || null;
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
  save();
  renderHome();
});

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
  saveEconomy();
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
  const accent = b ? b.color : "#f2c14e";
  const mmr = overallMMR();
  const streak = computeStreak();
  const liftCount = Object.keys(bests).length;

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0e2a1f"); bg.addColorStop(1, "#06140d");
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
  ctx.fillStyle = "#f2c14e";
  ctx.font = "700 64px Rajdhani, sans-serif";
  ctx.fillText("REPTILIFT", W / 2, 150);
  ctx.fillStyle = hexA("#eaf5ee", 0.6);
  ctx.font = "600 30px Rajdhani, sans-serif";
  ctx.fillText("CLIMB THE FOOD CHAIN", W / 2, 198);

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
  ctx.fillStyle = "#f2c14e";
  ctx.font = "700 200px Rajdhani, sans-serif";
  ctx.shadowColor = hexA("#f2c14e", 0.5); ctx.shadowBlur = 40;
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

// open the rank-card modal: draw, then show. Fonts may load a beat late on first
// paint, so redraw shortly after to pick up Rajdhani if it wasn't ready.
function openRankCard() {
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

// ===== startup animation =====
const appEl = document.getElementById("app");
function introTimers(introEl, firstLoad) {
  introEl.offsetWidth;                                                  // force reflow so a replay restarts clean
  window.setTimeout(() => introEl.classList.add("go"), 700);            // eyes glow open
  window.setTimeout(() => introEl.classList.add("title"), 1900);        // logo wipes in around them
  window.setTimeout(() => introEl.classList.add("look"), 3400);         // eyes blink & dart around
  if (firstLoad && appEl) window.setTimeout(() => appEl.classList.add("ready"), 5200);
  window.setTimeout(() => introEl.classList.add("hide"), 5200);
  window.setTimeout(() => { introEl.style.display = "none"; }, 6100);
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
  if (ax.chipLbl && cloudUser) ax.chipLbl.textContent = m.chip;
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
}

// ---- account form / UI wiring ----
function paintAccount() {
  if (!ax.wrap) return;
  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");
  hide(ax.disabled); hide(ax.loggedOut); hide(ax.loggedIn);

  if (!CLOUD_CONFIGURED) {
    show(ax.disabled);
    if (ax.chip) ax.chip.classList.add("hidden");   // hide chip when no cloud at all
    setSyncStatus("off");
    return;
  }
  if (cloudUser) {
    show(ax.loggedIn);
    if (ax.emailLbl) ax.emailLbl.textContent = cloudUser.email || "(signed in)";
    if (ax.chip) { ax.chip.classList.remove("hidden"); }
    if (ax.chipLbl) ax.chipLbl.textContent = "Synced";
    setSyncStatus("synced");
  } else {
    show(ax.loggedOut);
    if (ax.chip) ax.chip.classList.remove("hidden");
    if (ax.chipLbl) ax.chipLbl.textContent = "Sign in";
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

// Clicking the top "Sign in" chip opens the dedicated Account page (its own
// screen). When logged out, focus the email field as a nice touch.
if (ax.chip) ax.chip.addEventListener("click", () => {
  if (typeof switchTab === "function") switchTab("account-page");
  if (!cloudUser && ax.email) setTimeout(() => { try { ax.email.focus(); } catch (e) {} }, 300);
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
