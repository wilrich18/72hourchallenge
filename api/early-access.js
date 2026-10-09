// Vercel serverless function for the early-access form.
// Sign-ups are forwarded as JSON to EARLY_ACCESS_WEBHOOK_URL (for example a
// Zapier, Make, Slack or Google Apps Script webhook). If it isn't set, the
// function says so instead of pretending the sign-up was saved.

const ROLES = new Set(["family", "assisting", "physician", "other"]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const email = String(body.email || "").trim().slice(0, 254);
  const role = ROLES.has(body.role) ? body.role : "other";

  // Honeypot field: real people leave it empty.
  if (body.website) return res.status(200).json({ ok: true });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const webhook = process.env.EARLY_ACCESS_WEBHOOK_URL;
  if (!webhook) {
    return res.status(503).json({ error: "Sign-ups aren't connected yet." });
  }

  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role, submittedAt: new Date().toISOString(), source: "careloop-site" }),
    });
    if (!r.ok) throw new Error(`webhook responded ${r.status}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("early-access webhook failed:", err.message);
    return res.status(502).json({ error: "We couldn't save your sign-up." });
  }
};

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
