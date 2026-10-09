const L = require("./_lib");

// Starts a Whop checkout for the signed-in account, tagged with its email so the
// payment is matched to this account even if a different email is used at Whop.
module.exports = async function handler(req, res) {
  L.noStore(res);
  if (req.method !== "POST") return L.fail(res, 405, "Method not allowed.");
  try {
    const user = await L.currentUser(req);
    if (!user) return L.fail(res, 401, "Please log in first.");
    return res.status(200).json({ url: await L.createCheckout(user.email, L.origin(req)) });
  } catch (err) {
    console.error("checkout failed:", err.message);
    return L.fail(res, 502, "We couldn't start checkout. Please try again.");
  }
};
