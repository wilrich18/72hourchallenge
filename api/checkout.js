const L = require("./_lib");

// Starts a Whop checkout for the signed-in account, tagged with its email so the
// payment is matched to this account even if a different email is used at Whop.
module.exports = async function handler(req, res) {
  if (!L.onlyMethod(req, res, "POST")) return;
  const email = L.sessionEmail(req);
  if (!email) return res.status(401).json({ error: "Please log in first." });
  try {
    const origin = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
    return res.status(200).json({ url: await L.createCheckout(email, origin) });
  } catch (err) {
    console.error("checkout failed:", err.message);
    return res.status(502).json({ error: "We couldn't start checkout. Please try again." });
  }
};
