#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Service, safeError } from "../lib/service.mjs";
const [command = "help", ...args] = process.argv.slice(2);
const config = {
  dataDir: process.env.BILI_HUMANISM_HOME,
  credentialPath: process.env.BILI_HUMANISM_CREDENTIAL_FILE,
};
let service;
try {
  if (command === "help")
    console.log(
      "bili-humanism read BV [part] | candidates [1-3] | status | cancel ID | inbox | journal READING_ID note.json | import READING_ID segments.json | memory list/put/delete [ID] [json-file] | resume --acknowledge-account-risk\nConfigure local paths using BILI_HUMANISM_HOME / BILI_HUMANISM_CREDENTIAL_FILE. Never put credential values in command arguments.",
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
    else if (command === "status") result = service.store.status();
    else if (command === "cancel") {
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
