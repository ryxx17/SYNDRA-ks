// database.js
// Semua logika penyimpanan & aturan key ada di sini (satu sumber kebenaran,
// dipakai baik oleh bot Discord maupun API validasi).

const Database = require("better-sqlite3");
const { customAlphabet } = require("nanoid");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "keys.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    key_string          TEXT UNIQUE NOT NULL,
    duration_days       INTEGER,            -- NULL = lifetime (tidak pernah expired)
    created_at          INTEGER NOT NULL,   -- unix timestamp (detik) saat di-generate
    activated_at        INTEGER,            -- unix timestamp saat PERTAMA KALI dipakai (masa aktif dihitung dari sini, bukan dari created_at)
    expires_at          INTEGER,            -- dihitung otomatis begitu activated_at terisi
    hwid                TEXT,               -- terkunci ke device pertama yang pakai
    discord_user_id     TEXT,               -- siapa admin yang generate
    redeemed_by_user_id TEXT,               -- akun Discord pembeli yang meng-klaim key ini lewat tombol Redeem Key
    hwid_reset_at       INTEGER,            -- kapan terakhir kali user reset HWID sendiri (buat cooldown)
    revoked             INTEGER NOT NULL DEFAULT 0,
    note                TEXT
  );
`);

// Migrasi aman: kalau ada keys.db lama dari sebelum kolom ini ditambahkan,
// tambahkan kolomnya tanpa menghapus data yang sudah ada.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing("keys", "redeemed_by_user_id", "TEXT");
addColumnIfMissing("keys", "hwid_reset_at", "INTEGER");

const genKeyId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 5); // tanpa karakter yang gampang ketuker (0/O, 1/I, dll)

function formatKeyString() {
  return `SYN-${genKeyId()}-${genKeyId()}-${genKeyId()}`;
}

/** Generate key baru. durationDays = null berarti lifetime. */
function generateKey({ durationDays, discordUserId, note }) {
  const keyString = formatKeyString();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO keys (key_string, duration_days, created_at, discord_user_id, note)
     VALUES (?, ?, ?, ?, ?)`
  ).run(keyString, durationDays ?? null, now, discordUserId ?? null, note ?? null);
  return keyString;
}

function getKey(keyString) {
  return db.prepare(`SELECT * FROM keys WHERE key_string = ?`).get(keyString);
}

/**
 * Dipanggil dari endpoint /validate. Ini yang jadi "wasit" -- semua
 * perhitungan waktu & pengecekan terjadi DI SINI (server), bukan di client.
 */
function validateKey(keyString, hwid) {
  const row = getKey(keyString);
  const now = Math.floor(Date.now() / 1000);

  if (!row) return { valid: false, reason: "Key tidak ditemukan" };
  if (row.revoked) return { valid: false, reason: "Key sudah di-revoke" };

  // Aktivasi pertama kali: mulai hitung masa berlaku & kunci ke HWID ini
  if (!row.activated_at) {
    const expiresAt = row.duration_days
      ? now + row.duration_days * 86400
      : null; // lifetime
    db.prepare(
      `UPDATE keys SET activated_at = ?, expires_at = ?, hwid = ? WHERE key_string = ?`
    ).run(now, expiresAt, hwid ?? null, keyString);
    return { valid: true, reason: "Aktivasi pertama", expiresAt };
  }

  // Sudah pernah aktif -- cek HWID cocok (anti key-sharing)
  if (row.hwid && hwid && row.hwid !== hwid) {
    return { valid: false, reason: "Key sudah dipakai di device lain" };
  }

  // Cek kadaluarsa
  if (row.expires_at && now > row.expires_at) {
    return { valid: false, reason: "Key sudah kadaluarsa", expiresAt: row.expires_at };
  }

  return { valid: true, reason: "OK", expiresAt: row.expires_at };
}

function revokeKey(keyString) {
  const result = db.prepare(`UPDATE keys SET revoked = 1 WHERE key_string = ?`).run(keyString);
  return result.changes > 0;
}

function deleteKey(keyString) {
  const result = db.prepare(`DELETE FROM keys WHERE key_string = ?`).run(keyString);
  return result.changes > 0;
}

function extendKey(keyString, additionalDays) {
  const row = getKey(keyString);
  if (!row) return null;
  const base = row.expires_at && row.expires_at > Math.floor(Date.now() / 1000)
    ? row.expires_at
    : Math.floor(Date.now() / 1000);
  const newExpiry = base + additionalDays * 86400;
  db.prepare(`UPDATE keys SET expires_at = ? WHERE key_string = ?`).run(newExpiry, keyString);
  return newExpiry;
}

function listKeys({ onlyActive = false, limit = 20 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let rows = db.prepare(`SELECT * FROM keys ORDER BY created_at DESC LIMIT ?`).all(limit);
  if (onlyActive) {
    rows = rows.filter((r) => !r.revoked && (!r.expires_at || r.expires_at > now));
  }
  return rows;
}

/** Klaim sebuah key ke akun Discord tertentu (dipanggil dari tombol Redeem Key). */
function redeemKey(keyString, discordUserId) {
  const row = getKey(keyString);
  if (!row) return { ok: false, reason: "Key tidak ditemukan" };
  if (row.revoked) return { ok: false, reason: "Key sudah di-revoke" };
  if (row.redeemed_by_user_id && row.redeemed_by_user_id !== discordUserId) {
    return { ok: false, reason: "Key ini sudah diklaim akun Discord lain" };
  }
  db.prepare(`UPDATE keys SET redeemed_by_user_id = ? WHERE key_string = ?`).run(discordUserId, keyString);
  return { ok: true, row: getKey(keyString) };
}

/** Ambil key yang paling baru diklaim akun Discord ini (dipakai tombol Get Script/Role/Stats/Reset HWID). */
function getRedeemedKeyForUser(discordUserId) {
  return db
    .prepare(
      `SELECT * FROM keys WHERE redeemed_by_user_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1`
    )
    .get(discordUserId);
}

/** Reset HWID key milik user. cooldownDays = jarak minimal antar reset (anti-abuse). */
function resetHwidForUser(discordUserId, cooldownDays = 3) {
  const row = getRedeemedKeyForUser(discordUserId);
  if (!row) return { ok: false, reason: "Kamu belum redeem key apapun" };

  const now = Math.floor(Date.now() / 1000);
  if (row.hwid_reset_at && now - row.hwid_reset_at < cooldownDays * 86400) {
    const nextAllowed = row.hwid_reset_at + cooldownDays * 86400;
    return { ok: false, reason: "Cooldown belum habis", nextAllowed };
  }

  db.prepare(`UPDATE keys SET hwid = NULL, hwid_reset_at = ? WHERE key_string = ?`).run(now, row.key_string);
  return { ok: true };
}


module.exports = {
  generateKey,
  getKey,
  validateKey,
  revokeKey,
  deleteKey,
  extendKey,
  listKeys,
  redeemKey,
  getRedeemedKeyForUser,
  resetHwidForUser,
};

