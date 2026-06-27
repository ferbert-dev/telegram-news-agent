import { callTelegram, getTelegramConfig } from "./telegram.js";

const { token, channelId } = getTelegramConfig();
const bot = await callTelegram(token, "getMe", {});
const chat = await callTelegram(token, "getChat", { chat_id: channelId });

console.log(`Bot: @${bot.username}`);
console.log(`Channel: ${chat.title} (${chat.username ? `@${chat.username}` : chat.id})`);
console.log("Telegram configuration is valid.");
