#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Service, safeError } from "../lib/service.mjs";
import { resolveUnknown, resumeWrites } from "../lib/writer.mjs";
import {
  setupOptions,
  setupMedia,
  doctorMedia,
} from "../lib/media-environment.mjs";
import {
  revisePersonality,
  deletePersonality,
  rebuildPersonality,
  linkPersonality,
} from "../lib/personality.mjs";
const [command = "help", ...args] = process.argv.slice(2);
// Flags are read positionally after their name so a value can never be mistaken for a path or ID.
const parseFlags = (list, allowed) => {
  const flags = {};
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const key = list[i].startsWith("--") ? list[i].slice(2) : null;
    if (key && allowed.includes(key)) flags[key] = list[++i];
    else rest.push(list[i]);
  }
  return { flags, rest };
};
const audioOptions = (flags) => {
  const out = {};
  for (const [flag, key] of [
    ["bucket", "bucket"],
    ["threshold", "threshold"],
    ["min-run", "minRun"],
    ["max-seconds", "maxSeconds"],
  ])
    if (flags[flag] !== undefined) out[key] = Number(flags[flag]);
  return out;
};
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
      'bili-humanism setup-media [--python ABSOLUTE_PYTHON] [--asr --download-model] | doctor | audio READING_ID | local-asr READING_ID local-audio [LOCAL_MODEL] | read BV [part] | probe READING_ID [--names "object=form1,form2"] [--speech-seconds N] [--audio LOCAL_MEDIA] | audio-profile LOCAL_MEDIA | visual READING_ID | visual-frames READING_ID [OFFSET] | local-frames READING_ID local-video.mp4 | candidates [1-3] | status | question inspect [OFFSET] | question delete JOURNAL_ID --acknowledge-question-deletion | cancel ID | inbox [index | volume NUMBER SNAPSHOT | rebuild] | journal READING_ID note.json | import READING_ID segments.json | memory list/put/delete [ID] [json-file] | consumed READING_ID SECONDS --acknowledge-actual-consumption | history READING_ID CONSUMPTION_ID | favorite READING_ID FOLDER_ID add/remove | like READING_ID | coin READING_ID [TARGET_TOTAL] | personality read/select/skip/revise/delete/rebuild/link | write-resolve OPERATION_ID applied/not-applied --acknowledge-unknown-result | write-resume --acknowledge-account-risk | resume --acknowledge-account-risk\nConfigure trusted local paths using BILI_HUMANISM_HOME / BILI_HUMANISM_CREDENTIAL_FILE / BILI_HUMANISM_CONFIG_FILE. Never put credential values in command arguments.',
    );
  else if (command === "setup-media") {
    const options = setupOptions(args);
    console.log(
      JSON.stringify(
        await setupMedia(config, options, {
          progress: (stage) => console.error(JSON.stringify({ stage })),
        }),
        null,
        2,
      ),
    );
  } else if (command === "doctor") {
    if (args.length) throw new Error("doctor takes no arguments");
    const report = await doctorMedia(config);
    console.log(JSON.stringify(report, null, 2));
    if (report.frames.status !== "ready") process.exitCode = 2;
  } else {
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
    else if (command === "question") {
      if (args[0] === "inspect" && args.length <= 2)
        result = service.questions.inspect(
          args[1] === undefined ? 0 : Number(args[1]),
        );
      else if (
        args[0] === "delete" &&
        args.length === 3 &&
        args[2] === "--acknowledge-question-deletion"
      )
        result = service.questions.delete(args[1]);
      else
        throw new Error(
          "Use question inspect [OFFSET] or question delete JOURNAL_ID --acknowledge-question-deletion with the trusted private dataDir",
        );
    } else if (command === "shadow") {
      if (args[0] === "inspect" && args.length <= 2)
        result = service.shadow.inspect(
          args[1] === undefined ? 0 : Number(args[1]),
        );
      else if (
        args[0] === "erase" &&
        args.length === 2 &&
        args[1] === "--acknowledge-shadow-erasure"
      )
        result = service.shadow.erase();
      else
        throw new Error(
          "Use shadow inspect [OFFSET] or shadow erase --acknowledge-shadow-erasure with enablePersonalityShadow:true in trusted local config",
        );
    } else if (command === "consumed") {
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
    else if (command === "like")
      result = await service.platformWrite("likes", { readingId: args[0] });
    else if (command === "coin")
      result = await service.platformWrite("coins", {
        readingId: args[0],
        ...(args[1] === undefined ? {} : { totalCoins: Number(args[1]) }),
      });
    else if (command === "personality") {
      if (args[0] === "read")
        result = service.personality("read", { journalId: args[1] });
      else if (args[0] === "skip")
        result = service.personality("skip", {
          journalId: args[1],
          reason: args[2],
        });
      else if (args[0] === "select")
        result = service.personality("select", {
          journalId: args[1],
          sentence: JSON.parse(readFileSync(args[2], "utf8")).sentence,
        });
      else if (args[0] === "link") result = linkPersonality(args[1]);
      else {
        if (args.at(-1) !== "--acknowledge-personality-change")
          throw new Error("Missing personality change acknowledgement");
        if (args[0] === "revise")
          result = revisePersonality(
            service.store,
            args[1],
            args[2],
            JSON.parse(readFileSync(args[3], "utf8")).sentence,
          );
        else if (args[0] === "delete")
          result = deletePersonality(service.store, args[1]);
        else if (args[0] === "rebuild")
          result = rebuildPersonality(service.store);
        else throw new Error("Unknown personality command");
      }
    } else if (command === "write-resolve") {
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
    } else if (command === "inbox") {
      if (args[0] === "rebuild")
        result = {
          path: service.exportInbox(),
          ...service.inbox({ action: "index" }),
        };
      else if (args[0] === "index") result = service.inbox({ action: "index" });
      else if (args[0] === "volume")
        result = service.inbox({
          action: "volume",
          volume: Number(args[1]),
          snapshot: args[2],
        });
      else {
        if (args.length) throw new Error("Unknown inbox action");
        result = { entries: service.inbox(), path: service.exportInbox() };
      }
    } else if (command === "journal")
      result = service.journal(
        args[0],
        JSON.parse(readFileSync(args[1], "utf8")),
      );
    else if (command === "import")
      result = await service.importLocal(
        args[0],
        JSON.parse(readFileSync(args[1], "utf8")),
      );
    else if (command === "probe") {
      const { flags, rest } = parseFlags(args, [
        "names",
        "speech-seconds",
        "audio",
        "bucket",
        "threshold",
        "min-run",
        "max-seconds",
      ]);
      result = await service.probe(rest[0], {
        names: flags.names,
        speechSeconds:
          flags["speech-seconds"] === undefined
            ? undefined
            : Number(flags["speech-seconds"]),
        audioFile: flags.audio,
        audioOptions: audioOptions(flags),
      });
    } else if (command === "audio-profile") {
      const { flags, rest } = parseFlags(args, [
        "bucket",
        "threshold",
        "min-run",
        "max-seconds",
      ]);
      result = await service.audioProbe(rest[0], audioOptions(flags));
    } else if (command === "audio") result = await service.audio(args[0]);
    else if (command === "visual") result = await service.visual(args[0]);
    else if (command === "visual-frames")
      result = service.visualFrames(args[0], Number(args[1] || 0));
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
