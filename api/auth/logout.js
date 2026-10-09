const L = require("../_lib");

module.exports = function handler(req, res) {
  if (!L.onlyMethod(req, res, "POST")) return;
  L.clearSession(res);
  return res.status(200).json({ ok: true });
};
