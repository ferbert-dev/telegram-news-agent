import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { validateMessage } from "./telegram.js";

export function parseSendMessageArguments(args) {
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

export async function runSendMessageCli({
  args,
  dependencies: { readFile: read = readFile, log = console.log } = {},
}) {
  const options = parseSendMessageArguments(args);
  const text = validateMessage(
    options.file ? await read(options.file, "utf8") : options.text,
  );
  if (options.send) {
    throw new Error(
      "Direct Telegram publication is disabled. Publish an approved draft with `npm run drafts -- publish --id <draft-id>` or run the governed pipeline.",
    );
  }
  log("[preview] Offline: target configuration not loaded");
  log(`[preview] Characters: ${text.length}`);
  log("---");
  log(text);
  log("---");
  log("Nothing was sent. Direct --send is disabled; publish an approved draft through the governed pipeline.");
  return { status: "preview", text };
}

async function main() {
  await runSendMessageCli({ args: process.argv.slice(2) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
