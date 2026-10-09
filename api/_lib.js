// Shared server code. Files starting with "_" are not deployed as routes.
const crypto = require("crypto");
const { put, get, del } = require("@vercel/blob");

const TRIAL_DAYS = 7;
const SESSION_DAYS = 14;
const SUBSCRIPTION_RECHECK_MS = 6 * 3600 * 1000;
const COOKIE = "cl_session";
const MIN_PASSWORD = 10;
const VERIFY_TTL_MS = 48 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const EMAIL_RESEND_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
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
function noStore(res) { res.setHeader("Cache-Control", "no-store"); }
function fail(res, status, error, extra) { return res.status(status).json({ error, ...extra }); }
const normEmail = (e) => String(e || "").trim().toLowerCase().slice(0, 254);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const origin = (req) => `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- private JSON documents in Vercel Blob ----------
async function readJson(pathname) {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r || !r.stream) return null;
  // Compressed responses carry a weak ETag (W/"…"); conditional writes need the strong form.
  return { data: JSON.parse(await new Response(r.stream).text()), etag: r.blob.etag?.replace(/^W\//, "") };
}
async function writeJson(pathname, data, { create = false, etag } = {}) {
  return put(pathname, JSON.stringify(data), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: !create, // creating fails if the document already exists
    cacheControlMaxAge: 60,
    ...(etag ? { ifMatch: etag } : {}),
  });
}
const isConflict = (err) => /already exists|precondition|etag|does not match/i.test(`${err.name} ${err.message}`);

// ---------- users ----------
const userPath = (email) => `users/${sha256(email)}.json`;
async function getUser(email) { return (await readJson(userPath(email)))?.data || null; }
async function saveUser(user, { create = false } = {}) { await writeJson(userPath(user.email), user, { create }); }

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt, hash };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}
function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Please choose a password of at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "That password is too long.";
  return null;
}

// ---------- sessions (signed, HttpOnly cookie) ----------
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}
const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

// `sv` is the account's session version; bumping it (on password reset) logs out every device.
function setSession(res, user) {
  const payload = Buffer.from(JSON.stringify({ email: user.email, sv: user.sessionVersion || 0, exp: Date.now() + SESSION_DAYS * 86400000 })).toString("base64url");
  res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function readSession(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}
// The signed-in user, or null. Rejects sessions from before a password reset.
async function currentUser(req) {
  const s = readSession(req);
  if (!s) return null;
  const user = await getUser(s.email);
  if (!user || (user.sessionVersion || 0) !== (s.sv || 0)) return null;
  return user;
}

// ---------- email (Resend) ----------
async function sendEmail({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn(`RESEND_API_KEY is not set; not sending "${subject}"`); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || "Care Loop <onboarding@resend.dev>", to: [to], subject, text, html }),
  });
  if (!r.ok) { console.error(`Resend responded ${r.status}: ${(await r.text()).slice(0, 200)}`); return false; }
  return true;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function emailLayout(heading, paragraphs, button) {
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1f2a2e">
    <h2 style="color:#1d6b5f">${esc(heading)}</h2>${paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}
    ${button ? `<p><a href="${esc(button.url)}" style="display:inline-block;background:#1d6b5f;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">${esc(button.label)}</a></p>
    <p style="color:#55636a;font-size:13px">Or paste this link into your browser:<br>${esc(button.url)}</p>` : ""}
    <p style="color:#55636a;font-size:13px">Care Loop does not give medical advice.</p></div>`;
  const text = `${heading}\n\n${paragraphs.join("\n\n")}${button ? `\n\n${button.label}: ${button.url}` : ""}`;
  return { html, text };
}

// ---------- Whop ----------
async function whop(path, params) {
  const key = process.env.WHOP_API_KEY;
  if (!key) throw new Error("WHOP_API_KEY is not set");
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

async function createCheckout(email, appOrigin) {
  const key = process.env.WHOP_API_KEY;
  if (!key) return STATIC_CHECKOUT;
  const r = await fetch(`${WHOP_API}/checkout_configurations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      account_id: WHOP_COMPANY_ID,
      plan_id: WHOP_PLAN_ID,
      metadata: { careloop_email: email },
      redirect_url: `${appOrigin}/app?subscribed=1`,
    }),
  });
  if (!r.ok) throw new Error(`Whop checkout responded ${r.status}`);
  const data = await r.json();
  return data.purchase_url || STATIC_CHECKOUT;
}

// ---------- account status ----------
// Care team members invited by a paying family caregiver use Care Loop at no cost.
async function isTeamMember(email) {
  const ids = (await readJson(`access/${sha256(email)}.json`))?.data?.ids || [];
  for (const id of ids) {
    const p = (await readJson(`profiles/${id}.json`))?.data;
    if (p && (p.team || []).some((m) => m.email === email && m.status === "joined")) return true;
  }
  return false;
}

function trialInfo(user) {
  const endsAt = user.trialStartedAt + TRIAL_DAYS * 86400000;
  return { endsAt, daysLeft: Math.max(0, Math.ceil((endsAt - Date.now()) / 86400000)), active: Date.now() < endsAt };
}

// What the app needs to know about the signed-in person. Subscription status is only
// looked up once the trial is over, and cached on the account for a few hours.
async function accountStatus(user, { refresh = false } = {}) {
  const trial = trialInfo(user);
  let subscribed = !!user.subscribed;
  let checkFailed = false;
  if (!trial.active) {
    const stale = !user.subscriptionCheckedAt || Date.now() - user.subscriptionCheckedAt > SUBSCRIPTION_RECHECK_MS;
    if (refresh || stale) {
      try {
        subscribed = await hasActiveSubscription(user.email);
        const latest = (await getUser(user.email)) || user;
        await saveUser({ ...latest, subscribed, subscriptionCheckedAt: Date.now() });
      } catch (err) {
        console.error("subscription check failed:", err.message);
        checkFailed = true; // keep the last known status
      }
    }
  }
  const ownerAccess = trial.active || subscribed;
  const teamAccess = !ownerAccess && (await isTeamMember(user.email).catch(() => false));
  return {
    user: { name: user.name, email: user.email },
    verified: !!user.verified,
    trial: { endsAt: trial.endsAt, daysLeft: trial.daysLeft, active: trial.active },
    subscribed,
    ownerAccess,          // can create and own profiles
    access: ownerAccess || teamAccess,
    checkFailed,
  };
}

module.exports = {
  TRIAL_DAYS, MIN_PASSWORD, VERIFY_TTL_MS, RESET_TTL_MS, EMAIL_RESEND_MS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS,
  body, noStore, fail, normEmail, validEmail, origin, sha256, randomToken, safeEqual,
  readJson, writeJson, del, isConflict,
  getUser, saveUser, hashPassword, checkPassword, passwordProblem,
  setSession, clearSession, currentUser,
  sendEmail, emailLayout, accountStatus, createCheckout,
};
