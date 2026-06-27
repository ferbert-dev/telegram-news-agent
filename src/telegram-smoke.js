import { getTelegramConfig, sendTelegramMessage } from "./telegram.js";

const { token, channelId } = getTelegramConfig();
const timestamp = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Madrid",
}).format(new Date());

const message = [
  "System check",
  "",
  "Michael Honest AI News is connected and ready.",
  `Tested: ${timestamp} Europe/Madrid`,
].join("\n");

const sent = await sendTelegramMessage({
  token,
  channelId,
  text: message,
  disableNotification: true,
});

console.log(`Posted Telegram message ${sent.message_id} to ${channelId}.`);
