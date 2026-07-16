require("dotenv").config();

const { startBot } = require("./bot");
const { startApi } = require("./api");

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN belum diisi di .env -- bot tidak bisa jalan.");
  process.exit(1);
}

startBot();
startApi();
