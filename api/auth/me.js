const L = require("../_lib");

// Who is signed in, and whether they can use the app (trial or paid subscription).
module.exports = async function handler(req, res) {
  if (!L.onlyMethod(req, res, "GET")) return;
  try {
    const email = L.sessionEmail(req);
    const user = email && (await L.getUser(email));
    if (!user) {
      if (email) L.clearSession(res);
      return res.status(401).json({ error: "Not signed in." });
    }
    return res.status(200).json(await L.accountStatus(user, { refresh: req.query?.refresh === "1" }));
  } catch (err) {
    console.error("me failed:", err.message);
    return res.status(500).json({ error: "We couldn't load your account. Please try again." });
  }
};
