#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Service, safeError } from "../lib/service.mjs";
import { resolveUnknown, resumeWrites } from "../lib/writer.mjs";
const [command = "help", ...args] = process.argv.slice(2);
const config = {
  dataDir: process.env.BILI_HUMANISM_HOME,
  credentialPath: process.env.BILI_HUMANISM_CREDENTIAL_FILE,
};
let service;
try {
  if (process.env.BILI_HUMANISM_CONFIG_FILE)
    Object.assign(
      config,
      JSON.parse(readFileSync(process.env.BILI_HUMANISM_CONFIG_FILE, "utf8")),
    );
  if (command === "help")
    console.log(
      "bili-humanism read BV [part] | candidates [1-3] | status | cancel ID | inbox | journal READING_ID note.json | import READING_ID segments.json | memory list/put/delete [ID] [json-file] | consumed READING_ID SECONDS --acknowledge-actual-consumption | history READING_ID CONSUMPTION_ID | favorite READING_ID FOLDER_ID add/remove | write-resolve OPERATION_ID applied/not-applied --acknowledge-unknown-result | write-resume --acknowledge-account-risk | resume --acknowledge-account-risk\nConfigure trusted local paths using BILI_HUMANISM_HOME / BILI_HUMANISM_CREDENTIAL_FILE / BILI_HUMANISM_CONFIG_FILE. Never put credential values in command arguments.",
    );
  else {
    service = new Service(config);
    let result;
    if (command === "read")
      result = await service.read(
        args[0],
        args[1] === undefined ? undefined : Number(args[1]),
      );
    else if (command === "candidates")
      result = await service.candidates(Number(args[0] || 3));
    else if (command === "status") result = service.status();
    else if (command === "consumed") {
      if (args[2] !== "--acknowledge-actual-consumption")
        throw new Error("Missing explicit consumption acknowledgement");
      result = service.confirmConsumption(args[0], Number(args[1]));
    } else if (command === "history")
      result = await service.platformWrite("history", {
        readingId: args[0],
        consumptionId: args[1],
      });
    else if (command === "favorite")
      result = await service.platformWrite("favorites", {
        readingId: args[0],
        folderId: args[1],
        action: args[2],
      });
    else if (command === "write-resolve") {
      if (args[2] !== "--acknowledge-unknown-result")
        throw new Error("Missing explicit unknown-result acknowledgement");
      result = resolveUnknown(config, args[0], args[1]);
    } else if (command === "write-resume") {
      if (args[0] !== "--acknowledge-account-risk")
        throw new Error("Missing explicit risk acknowledgement");
      result = resumeWrites(config);
    } else if (command === "cancel") {
      service.store.cancel(args[0]);
      result = { cancelRequested: true };
    } else if (command === "inbox")
      result = { entries: service.store.inbox(), path: service.exportInbox() };
    else if (command === "journal")
      result = service.journal(
        args[0],
        JSON.parse(readFileSync(args[1], "utf8")),
      );
    else if (command === "import")
      result = await service.importLocal(
        args[0],
        JSON.parse(readFileSync(args[1], "utf8")),
      );
    else if (command === "audio") result = await service.audio(args[0]);
    else if (command === "local-asr")
      result = await service.localMedia("asr", args[0], args[1], args[2]);
    else if (command === "local-frames")
      result = await service.localMedia("frames", args[0], args[1]);
    else if (command === "memory")
      result = service.memory(
        args[0],
        args[1] || "",
        args[2] ? JSON.parse(readFileSync(args[2], "utf8")) : null,
      );
    else if (command === "resume") {
      if (args[0] !== "--acknowledge-account-risk")
        throw new Error("Missing explicit acknowledgement");
      service.store.resume();
      result = {
        pauseCleared: true,
        note: "Manual acknowledgement; no platform safety guarantee.",
      };
    } else throw new Error("Unknown command");
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) {
  console.error(JSON.stringify(safeError(e)));
  process.exitCode = 1;
} finally {
  service?.close();
}
