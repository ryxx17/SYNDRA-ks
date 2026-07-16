// api.js
// Endpoint HTTP yang dipanggil oleh script Roblox (lewat game:HttpGet) buat
// validasi key. Ini "wasit" yang sebenarnya -- semua keputusan valid/tidak
// terjadi di server ini, bukan di client (yang bisa diedit user).

const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("./database");

function startApi() {
  const app = express();

  // Batasi biar nggak gampang di-brute-force nebak key
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20, // 20 request/menit per IP
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/validate", limiter);

  app.get("/validate", (req, res) => {
    const key = String(req.query.key || "").trim().toUpperCase();
    const hwid = req.query.hwid ? String(req.query.hwid).trim() : null;

    if (!key) {
      return res.status(400).json({ valid: false, reason: "Parameter 'key' wajib diisi" });
    }

    const result = db.validateKey(key, hwid);
    return res.json(result);
  });

  app.get("/", (_req, res) => res.send("Syndra key server jalan."));

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[API] Jalan di port ${port}`));
}

module.exports = { startApi };

