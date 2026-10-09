// Uploaded charts and prescriptions, stored privately in Vercel Blob.
//   POST  upload handshake from the browser (@vercel/blob/client); checks the caller may add files
//   GET   ?profile=…&doc=…  streams a file to anyone on that profile's care team
const { Readable } = require("stream");
const { get } = require("@vercel/blob");
const { handleUpload } = require("@vercel/blob/client");
const L = require("./_lib");
const P = require("./_profiles");

const MAX_UPLOAD = 20 * 1024 * 1024;

module.exports = async function handler(req, res) {
  L.noStore(res);
  try {
    const user = await L.currentUser(req);
    if (!user) return L.fail(res, 401, "Please log in first.");
    if (!(await L.accountStatus(user)).access) return L.fail(res, 402, "Your free trial has ended. Subscribe to keep using Care Loop.");
    if (req.method === "POST") return await upload(req, res, user);
    if (req.method === "GET") return await download(req, res, user);
    return L.fail(res, 405, "Method not allowed.");
  } catch (err) {
    console.error("files failed:", err.message);
    return L.fail(res, 400, err.message.startsWith("Upload refused:") ? err.message.slice(16) : "Something went wrong with that file.");
  }
};

async function upload(req, res, user) {
  const result = await handleUpload({
    request: req,
    body: L.body(req),
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      let profileId;
      try { profileId = JSON.parse(clientPayload || "{}").profileId; } catch { /* handled below */ }
      const found = await P.getProfile(profileId);
      const role = found && P.roleOf(found.data, user.email);
      if (!P.can(role, "notes")) throw new Error("Upload refused: your role can't upload files to this profile.");
      if (!new RegExp(`^files/${profileId}/[a-z0-9]{6,40}-[\\w.\\- ]{1,120}$`).test(pathname)) throw new Error("Upload refused: invalid file name.");
      return {
        allowedContentTypes: ["application/pdf", "image/*"],
        maximumSizeInBytes: MAX_UPLOAD,
        addRandomSuffix: false,
        allowOverwrite: false,
      };
    },
  });
  return res.status(200).json(result);
}

async function download(req, res, user) {
  const found = await P.getProfile(req.query.profile);
  if (!found || !P.roleOf(found.data, user.email)) return L.fail(res, 404, "File not found.");
  const doc = (found.data.docs || []).find((d) => d.id === req.query.doc);
  if (!doc) return L.fail(res, 404, "File not found.");
  const r = await get(doc.pathname, { access: "private" });
  if (!r || !r.stream) return L.fail(res, 404, "File not found.");
  res.setHeader("Content-Type", r.blob.contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${String(doc.name).replace(/[^\w.\- ]/g, "_")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  Readable.fromWeb(r.stream).pipe(res);
}
