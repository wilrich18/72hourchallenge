// Checks with Whop whether an email address has an active Care Loop subscription.
// Needs WHOP_API_KEY (a Whop company API key with member and membership read access,
// including member:email:read). WHOP_COMPANY_ID and WHOP_PLAN_ID default to the
// live Care Loop business and monthly plan.

const API = "https://api.whop.com/api/v1";
const COMPANY_ID = process.env.WHOP_COMPANY_ID || "biz_BoKJoB5TlAHfhY";
const PLAN_ID = process.env.WHOP_PLAN_ID || "plan_dIPsSbDYnGhzG";
// "canceling" means cancelled but still paid up until the end of the period.
const ACTIVE = new Set(["active", "trialing", "canceling"]);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const key = process.env.WHOP_API_KEY;
  if (!key) return res.status(503).json({ error: "Subscription checks aren't connected yet." });

  try {
    const members = await whop(key, "/members", { account_id: COMPANY_ID, query: email, first: "10" });
    const userIds = (members.data || [])
      .filter((m) => !m.user?.email || m.user.email.toLowerCase() === email)
      .map((m) => m.user?.id)
      .filter(Boolean);

    for (const userId of userIds) {
      const memberships = await whop(key, "/memberships", { account_id: COMPANY_ID, user_id: userId, plan_id: PLAN_ID });
      if ((memberships.data || []).some((m) => ACTIVE.has(m.status))) {
        return res.status(200).json({ active: true });
      }
    }
    return res.status(200).json({ active: false });
  } catch (err) {
    console.error("verify-subscription failed:", err.message);
    return res.status(502).json({ error: "We couldn't reach Whop to check your subscription." });
  }
};

async function whop(key, path, params) {
  const r = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${path} responded ${r.status}`);
  return r.json();
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
