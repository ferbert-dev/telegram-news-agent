import { readFile } from "node:fs/promises";
import { getTelegramConfig, sendTelegramMessage, validateMessage } from "./telegram.js";

function parseArguments(args) {
  const options = {
    send: false,
    silent: false,
    text: undefined,
    file: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--send") {
      options.send = true;
    } else if (argument === "--silent") {
      options.silent = true;
    } else if (argument === "--text" || argument === "--file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (Boolean(options.text) === Boolean(options.file)) {
    throw new Error("Provide exactly one of --text or --file");
  }

  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const text = validateMessage(
    options.file ? await readFile(options.file, "utf8") : options.text,
  );
  const { token, channelId } = getTelegramConfig();

  if (!options.send) {
    console.log(`[preview] Target: ${channelId}`);
    console.log(`[preview] Characters: ${text.length}`);
    console.log("---");
    console.log(text);
    console.log("---");
    console.log("Nothing was sent. Add --send to publish.");
    return;
  }

  const sent = await sendTelegramMessage({
    token,
    channelId,
    text,
    disableNotification: options.silent,
  });

  console.log(`Posted Telegram message ${sent.message_id} to ${channelId}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
