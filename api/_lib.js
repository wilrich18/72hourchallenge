// Shared helpers for the account API. Files starting with "_" are not deployed as routes.
const crypto = require("crypto");
const { put, get } = require("@vercel/blob");

const TRIAL_DAYS = 7;
const SESSION_DAYS = 14;
const SUBSCRIPTION_RECHECK_MS = 6 * 3600 * 1000;
const COOKIE = "cl_session";
const WHOP_API = "https://api.whop.com/api/v1";
const WHOP_COMPANY_ID = process.env.WHOP_COMPANY_ID || "biz_BoKJoB5TlAHfhY";
const WHOP_PLAN_ID = process.env.WHOP_PLAN_ID || "plan_dIPsSbDYnGhzG";
const STATIC_CHECKOUT = "https://whop.com/checkout/ch_hxaIOuGRbiYUxHr/";
// "canceling" means cancelled but paid up until the end of the current period.
const ACTIVE_STATUSES = new Set(["active", "trialing", "canceling"]);

// ---------- requests ----------
function body(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}
function onlyMethod(req, res, method) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === method) return true;
  res.setHeader("Allow", method);
  res.status(405).json({ error: "Method not allowed." });
  return false;
}
const normEmail = (e) => String(e || "").trim().toLowerCase().slice(0, 254);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---------- user store (private Vercel Blob, one JSON file per account) ----------
const userPath = (email) => `users/${crypto.createHash("sha256").update(email).digest("hex")}.json`;

async function getUser(email) {
  const r = await get(userPath(email), { access: "private", useCache: false });
  if (!r) return null;
  return JSON.parse(await new Response(r.stream).text());
}
async function saveUser(user, { create = false } = {}) {
  await put(userPath(user.email), JSON.stringify(user), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: !create, // creating fails if the account already exists
    cacheControlMaxAge: 60,
  });
}

// ---------- passwords ----------
const MIN_PASSWORD = 10;
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt, hash };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}

// ---------- sessions (signed, HttpOnly cookie) ----------
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}
const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

function setSession(res, email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_DAYS * 86400000 })).toString("base64url");
  res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function sessionEmail(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return exp > Date.now() ? email : null;
  } catch { return null; }
}

// ---------- Whop ----------
async function whop(path, params) {
  const key = process.env.WHOP_API_KEY;
  if (!key) throw Object.assign(new Error("WHOP_API_KEY is not set"), { code: "NO_KEY" });
  const r = await fetch(`${WHOP_API}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Whop ${path} responded ${r.status}`);
  return r.json();
}

// True when this Care Loop account has a paid-up membership on the monthly plan.
// Matches checkouts started from the app (tagged with the account email), then falls
// back to a Whop member with the same email address.
async function hasActiveSubscription(email) {
  let after;
  do {
    const page = await whop("/memberships", { account_id: WHOP_COMPANY_ID, plan_id: WHOP_PLAN_ID, first: "100", ...(after ? { after } : {}) });
    if ((page.data || []).some((m) => ACTIVE_STATUSES.has(m.status) && normEmail(m.metadata?.careloop_email) === email)) return true;
    after = page.page_info?.has_next_page ? page.page_info.end_cursor : null;
  } while (after);

  const members = await whop("/members", { account_id: WHOP_COMPANY_ID, query: email, first: "10" });
  const userIds = (members.data || [])
    .filter((m) => !m.user?.email || normEmail(m.user.email) === email)
    .map((m) => m.user?.id)
    .filter(Boolean);
  for (const userId of userIds) {
    const ms = await whop("/memberships", { account_id: WHOP_COMPANY_ID, user_id: userId, plan_id: WHOP_PLAN_ID });
    if ((ms.data || []).some((m) => ACTIVE_STATUSES.has(m.status))) return true;
  }
  return false;
}

async function createCheckout(email, origin) {
  const key = process.env.WHOP_API_KEY;
  if (!key) return STATIC_CHECKOUT;
  const r = await fetch(`${WHOP_API}/checkout_configurations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      account_id: WHOP_COMPANY_ID,
      plan_id: WHOP_PLAN_ID,
      metadata: { careloop_email: email },
      redirect_url: `${origin}/app?subscribed=1`,
    }),
  });
  if (!r.ok) throw new Error(`Whop checkout responded ${r.status}`);
  const data = await r.json();
  return data.purchase_url || STATIC_CHECKOUT;
}

// ---------- account status ----------
function trialInfo(user) {
  const endsAt = user.trialStartedAt + TRIAL_DAYS * 86400000;
  return { endsAt, daysLeft: Math.max(0, Math.ceil((endsAt - Date.now()) / 86400000)), active: Date.now() < endsAt };
}

// Returns what the app needs to know about the signed-in person. Subscription status
// is only looked up once the trial is over, and cached on the account for a few hours.
async function accountStatus(user, { refresh = false } = {}) {
  const trial = trialInfo(user);
  let subscribed = !!user.subscribed;
  let checkFailed = false;
  if (!trial.active) {
    const stale = !user.subscriptionCheckedAt || Date.now() - user.subscriptionCheckedAt > SUBSCRIPTION_RECHECK_MS;
    if (refresh || stale) {
      try {
        subscribed = await hasActiveSubscription(user.email);
        await saveUser({ ...user, subscribed, subscriptionCheckedAt: Date.now() });
      } catch (err) {
        console.error("subscription check failed:", err.message);
        checkFailed = true; // keep the last known status
      }
    }
  }
  return {
    user: { name: user.name, email: user.email },
    trial: { endsAt: trial.endsAt, daysLeft: trial.daysLeft, active: trial.active },
    subscribed,
    access: trial.active || subscribed,
    checkFailed,
  };
}

module.exports = {
  TRIAL_DAYS, MIN_PASSWORD, body, onlyMethod, normEmail, validEmail,
  getUser, saveUser, hashPassword, checkPassword,
  setSession, clearSession, sessionEmail, accountStatus, createCheckout,
};
