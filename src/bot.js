// bot.js
// Panel manajemen key lewat Discord slash command.

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const db = require("./database");

const DURATION_CHOICES = [
  { name: "1 Hari", value: "1" },
  { name: "7 Hari", value: "7" },
  { name: "30 Hari", value: "30" },
  { name: "Lifetime", value: "lifetime" },
];

function fmtTime(unixSeconds) {
  if (!unixSeconds) return "Lifetime / belum aktif";
  return `<t:${unixSeconds}:F> (<t:${unixSeconds}:R>)`; // format waktu Discord otomatis
}

function isAdmin(interaction) {
  const allowedUserIds = (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedUserIds.includes(interaction.user.id)) return true;

  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && interaction.member?.roles?.cache?.has(adminRoleId)) return true;

  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

function isKeyCurrentlyValid(row) {
  if (!row || row.revoked) return false;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && now > row.expires_at) return false;
  return true;
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle(process.env.PANEL_TITLE || "Syndra Control Panel")
    .setDescription(
      (process.env.PANEL_DESC ||
        "Kelola akses script kamu di sini.\n\nSudah beli? Pakai tombol di bawah buat redeem key, ambil script, ambil role, atau reset device.")
    )
    .setColor(0x4ec9e4);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("redeem_key_btn").setLabel("Redeem Key").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("get_script_btn").setLabel("Get Script").setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("get_role_btn").setLabel("Get Role").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("reset_hwid_btn").setLabel("Reset HWID").setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("get_stats_btn").setLabel("Get Stats").setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

const commands = [
  new SlashCommandBuilder()
    .setName("generatekey")
    .setDescription("Generate key baru (admin only)")
    .addStringOption((opt) =>
      opt
        .setName("durasi")
        .setDescription("Masa berlaku key")
        .setRequired(true)
        .addChoices(...DURATION_CHOICES)
    )
    .addStringOption((opt) =>
      opt.setName("catatan").setDescription("Catatan opsional (misal nama pembeli)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("checkkey")
    .setDescription("Cek status sebuah key")
    .addStringOption((opt) => opt.setName("key").setDescription("Key yang mau dicek").setRequired(true)),

  new SlashCommandBuilder()
    .setName("revokekey")
    .setDescription("Nonaktifkan sebuah key (admin only)")
    .addStringOption((opt) => opt.setName("key").setDescription("Key yang mau di-revoke").setRequired(true)),

  new SlashCommandBuilder()
    .setName("extendkey")
    .setDescription("Perpanjang masa berlaku key (admin only)")
    .addStringOption((opt) => opt.setName("key").setDescription("Key yang mau diperpanjang").setRequired(true))
    .addIntegerOption((opt) => opt.setName("hari").setDescription("Tambah berapa hari").setRequired(true)),

  new SlashCommandBuilder()
    .setName("listkeys")
    .setDescription("Lihat key yang masih aktif (admin only)"),

  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post panel tombol (Redeem/Get Script/Get Role/dst) di channel ini (admin only)"),
].map((c) => c.toJSON());

async function registerCommands(client) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    // Daftar ke 1 server aja -- muncul instan, cocok buat development/panel privat
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
  } else {
    // Global -- bisa makan waktu sampai 1 jam buat muncul di semua server
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  }
}

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === "redeem_key_btn") {
    const modal = new ModalBuilder().setCustomId("redeem_key_modal").setTitle("Redeem Key");
    const input = new TextInputBuilder()
      .setCustomId("key_input")
      .setLabel("Masukkan key kamu")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("SYN-XXXXX-XXXXX-XXXXX")
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === "get_script_btn") {
    const row = db.getRedeemedKeyForUser(interaction.user.id);
    if (!row) {
      return interaction.reply({ content: "Kamu belum redeem key. Tekan tombol **Redeem Key** dulu.", ephemeral: true });
    }
    if (!isKeyCurrentlyValid(row)) {
      return interaction.reply({ content: "Key kamu sudah tidak aktif (revoked/kadaluarsa). Hubungi admin.", ephemeral: true });
    }
    const loaderUrl = process.env.SCRIPT_LOADER_URL;
    if (!loaderUrl) {
      return interaction.reply({ content: "Link script belum di-setting admin (env `SCRIPT_LOADER_URL` kosong).", ephemeral: true });
    }
    return interaction.reply({
      content: `Paste ini di executor kamu:\n\`\`\`lua\nloadstring(game:HttpGet("${loaderUrl}"))()\n\`\`\``,
      ephemeral: true,
    });
  }

  if (id === "get_role_btn") {
    const row = db.getRedeemedKeyForUser(interaction.user.id);
    if (!row || !isKeyCurrentlyValid(row)) {
      return interaction.reply({ content: "Kamu belum punya key aktif yang di-redeem.", ephemeral: true });
    }
    const roleId = process.env.BUYER_ROLE_ID;
    if (!roleId) {
      return interaction.reply({ content: "Role belum di-setting admin (env `BUYER_ROLE_ID` kosong).", ephemeral: true });
    }
    try {
      await interaction.member.roles.add(roleId);
      return interaction.reply({ content: "Role berhasil diberikan!", ephemeral: true });
    } catch (err) {
      console.error("[BOT] Gagal kasih role:", err);
      return interaction.reply({
        content: "Gagal kasih role -- pastikan role bot di pengaturan server posisinya DI ATAS role buyer.",
        ephemeral: true,
      });
    }
  }

  if (id === "reset_hwid_btn") {
    const cooldownDays = parseInt(process.env.HWID_RESET_COOLDOWN_DAYS || "3", 10);
    const result = db.resetHwidForUser(interaction.user.id, cooldownDays);
    if (!result.ok) {
      if (result.nextAllowed) {
        return interaction.reply({ content: `Belum bisa reset lagi. Coba lagi ${fmtTime(result.nextAllowed)}.`, ephemeral: true });
      }
      return interaction.reply({ content: result.reason, ephemeral: true });
    }
    return interaction.reply({ content: "HWID berhasil direset. Key kamu bisa dipakai di device baru sekarang.", ephemeral: true });
  }

  if (id === "get_stats_btn") {
    const row = db.getRedeemedKeyForUser(interaction.user.id);
    if (!row) {
      return interaction.reply({ content: "Kamu belum redeem key apapun.", ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle("Key Kamu")
      .setColor(isKeyCurrentlyValid(row) ? 0x4ec9e4 : 0xe05252)
      .addFields(
        { name: "Key", value: `\`${row.key_string}\`` },
        { name: "Status", value: row.revoked ? "Di-revoke" : "Aktif" },
        { name: "Aktivasi Pertama", value: row.activated_at ? fmtTime(row.activated_at) : "Belum pernah dipakai" },
        { name: "Berakhir", value: fmtTime(row.expires_at) },
        { name: "Terkunci ke Device", value: row.hwid ? "Ya" : "Belum" }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

async function handleModalSubmit(interaction) {
  if (interaction.customId !== "redeem_key_modal") return;

  const keyString = interaction.fields.getTextInputValue("key_input").trim().toUpperCase();
  const result = db.redeemKey(keyString, interaction.user.id);

  if (!result.ok) {
    return interaction.reply({ content: `Gagal redeem: ${result.reason}`, ephemeral: true });
  }
  return interaction.reply({
    content: `Key \`${keyString}\` berhasil di-redeem ke akun kamu! Sekarang bisa pakai tombol **Get Script**, **Get Role**, dll di panel.`,
    ephemeral: true,
  });
}

function startBot() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async () => {
    console.log(`[BOT] Login sebagai ${client.user.tag}`);
    await registerCommands(client);
    console.log("[BOT] Slash command terdaftar");
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton()) {
        return await handleButton(interaction);
      }

      if (interaction.isModalSubmit()) {
        return await handleModalSubmit(interaction);
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "generatekey") {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: "Kamu tidak punya izin buat pakai command ini.", ephemeral: true });
        }
        const durasiRaw = interaction.options.getString("durasi");
        const catatan = interaction.options.getString("catatan");
        const durationDays = durasiRaw === "lifetime" ? null : parseInt(durasiRaw, 10);

        const keyString = db.generateKey({
          durationDays,
          discordUserId: interaction.user.id,
          note: catatan,
        });

        const embed = new EmbedBuilder()
          .setTitle("Key Baru Dibuat")
          .setColor(0x4ec9e4)
          .addFields(
            { name: "Key", value: `\`${keyString}\`` },
            { name: "Durasi", value: durasiRaw === "lifetime" ? "Lifetime" : `${durationDays} hari (dihitung sejak pertama dipakai)` },
            { name: "Catatan", value: catatan || "-" }
          );
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "checkkey") {
        const keyString = interaction.options.getString("key").trim().toUpperCase();
        const row = db.getKey(keyString);
        if (!row) return interaction.reply({ content: "Key tidak ditemukan.", ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle(`Status Key: ${keyString}`)
          .setColor(row.revoked ? 0xe05252 : 0x4ec9e4)
          .addFields(
            { name: "Status", value: row.revoked ? "Di-revoke" : "Aktif" },
            { name: "Aktivasi Pertama", value: row.activated_at ? fmtTime(row.activated_at) : "Belum pernah dipakai" },
            { name: "Berakhir", value: fmtTime(row.expires_at) },
            { name: "Terkunci ke Device", value: row.hwid ? "Ya" : "Belum" }
          );
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "revokekey") {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: "Kamu tidak punya izin buat pakai command ini.", ephemeral: true });
        }
        const keyString = interaction.options.getString("key").trim().toUpperCase();
        const ok = db.revokeKey(keyString);
        return interaction.reply({
          content: ok ? `Key \`${keyString}\` berhasil di-revoke.` : "Key tidak ditemukan.",
          ephemeral: true,
        });
      }

      if (interaction.commandName === "extendkey") {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: "Kamu tidak punya izin buat pakai command ini.", ephemeral: true });
        }
        const keyString = interaction.options.getString("key").trim().toUpperCase();
        const hari = interaction.options.getInteger("hari");
        const newExpiry = db.extendKey(keyString, hari);
        if (newExpiry === null) {
          return interaction.reply({ content: "Key tidak ditemukan.", ephemeral: true });
        }
        return interaction.reply({
          content: `Key \`${keyString}\` diperpanjang. Berakhir sekarang: ${fmtTime(newExpiry)}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "listkeys") {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: "Kamu tidak punya izin buat pakai command ini.", ephemeral: true });
        }
        const rows = db.listKeys({ onlyActive: true, limit: 15 });
        if (rows.length === 0) {
          return interaction.reply({ content: "Belum ada key aktif.", ephemeral: true });
        }
        const desc = rows
          .map((r) => `\`${r.key_string}\` -- berakhir: ${r.expires_at ? fmtTime(r.expires_at) : "Lifetime/belum aktif"}`)
          .join("\n");
        const embed = new EmbedBuilder().setTitle("Key Aktif (15 terbaru)").setColor(0x4ec9e4).setDescription(desc);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "panel") {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: "Kamu tidak punya izin buat pakai command ini.", ephemeral: true });
        }
        await interaction.channel.send(buildPanel());
        return interaction.reply({ content: "Panel diposting di channel ini.", ephemeral: true });
      }
    } catch (err) {
      console.error("[BOT] Error saat proses command:", err);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: "Terjadi error, cek log server.", ephemeral: true });
      } else {
        await interaction.reply({ content: "Terjadi error, cek log server.", ephemeral: true });
      }
    }
  });

  client.login(process.env.DISCORD_TOKEN);
  return client;
}

module.exports = { startBot };

