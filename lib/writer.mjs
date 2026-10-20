import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store, digest, now } from "./store.mjs";
import { credential } from "./network.mjs";
import { bvid } from "./reader.mjs";
import { Fault, need } from "./errors.mjs";

const API = "https://api.bilibili.com";
const routes = {
  folders: "/x/v3/fav/folder/created/list-all",
  history: "/x/web-interface/history/cursor",
  historyPost: "/x/v2/history/report",
  favoritePost: "/x/v3/fav/resource/deal",
};
const numeric = (value) =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,15}$/.test(value) &&
  Number.isSafeInteger(Number(value));
function jsonFile(path, code) {
  try {
    const bytes = readFileSync(path);
    need(bytes.length <= 65536, code);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Fault(code);
  }
}
export function grant(config, kind) {
  need(
    config[
      kind === "history" ? "enableHistoryWrites" : "enableFavoriteWrites"
    ] === true,
    "WRITE_DISABLED",
  );
  const p = jsonFile(config.writePolicyPath, "WRITE_POLICY_INVALID");
  need(
    p?.version === 1 &&
      p.enabled === true &&
      p.handoverConfirmed === true &&
      numeric(p.accountId),
    "WRITE_POLICY_INVALID",
  );
  need(
    typeof p.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(p.id),
    "WRITE_POLICY_INVALID",
  );
  need(
    typeof p.expiresAt === "string" &&
      Number.isFinite(Date.parse(p.expiresAt)) &&
      Date.parse(p.expiresAt) > Date.now(),
    "WRITE_GRANT_EXPIRED",
  );
  need(p[kind]?.enabled === true, "WRITE_SCOPE_DENIED");
  need(
    Number.isInteger(p[kind].maxWrites) &&
      p[kind].maxWrites >= 1 &&
      p[kind].maxWrites <= 100,
    "WRITE_POLICY_INVALID",
  );
  need(
    p.allReadings === true ||
      (Array.isArray(p.videos) &&
        p.videos.length > 0 &&
        p.videos.length <= 100 &&
        p.videos.every((v) => bvid(v) === v)),
    "WRITE_POLICY_INVALID",
  );
  return p;
}
function secrets(path) {
  const session = credential(path);
  const j = jsonFile(path, "WRITE_CREDENTIAL_INVALID");
  need(
    session &&
      j.write_valid !== false &&
      /^[a-fA-F0-9]{32}$/.test(j.bili_jct || ""),
    "WRITE_CREDENTIAL_INVALID",
  );
  return { session, csrf: j.bili_jct };
}
export function accountStore(config, accountId) {
  need(numeric(accountId), "WRITE_POLICY_INVALID");
  const root =
    config.accountStateDir ||
    join(
      process.env.DSH_HOME || join(homedir(), ".dsh"),
      "bili-humanism-accounts",
    );
  return new Store(join(root, accountId));
}
export function confirmConsumption(store, readingId, seconds) {
  const r = store.reading(readingId);
  need(
    Number.isInteger(seconds) && seconds > 0 && seconds <= r.duration,
    "INVALID_CONSUMPTION_PROGRESS",
  );
  const id = randomUUID();
  store.setControl("consumption:" + id, {
    readingId,
    bvid: r.bvid,
    cid: r.cid,
    seconds,
    confirmedAt: now(),
    confirmedBy: "local-human",
  });
  return { id, readingId, seconds, status: "human_confirmed_consumption" };
}
function idle(state) {
  for (const task of state.db
    .prepare("SELECT id,pid FROM tasks WHERE status='running'")
    .all()) {
    let alive = true;
    try {
      process.kill(task.pid, 0);
    } catch (e) {
      alive = e.code !== "ESRCH";
    }
    need(!alive, "TASK_BUSY");
    state.finish(task.id, "interrupted", "PROCESS_EXIT");
  }
}
export function resolveUnknown(config, operationId, outcome) {
  need(["applied", "not-applied"].includes(outcome), "INVALID_WRITE_OUTCOME");
  const p = jsonFile(config.writePolicyPath, "WRITE_POLICY_INVALID");
  const state = accountStore(config, p.accountId);
  try {
    state.tx(() => {
      idle(state);
      const item = state.getControl("write:pending");
      need(item?.id === operationId, "UNKNOWN_WRITE_NOT_FOUND");
      state.setControl("write:receipt:" + operationId, {
        ...item,
        status: "human_resolved_" + outcome,
        resolvedAt: now(),
      });
      state.setControl("write:pending", null);
    });
    return {
      id: operationId,
      status: "human_resolved_" + outcome,
      pausePreserved: true,
    };
  } finally {
    state.close();
  }
}
export function resumeWrites(config) {
  const p = jsonFile(config.writePolicyPath, "WRITE_POLICY_INVALID");
  const state = accountStore(config, p.accountId);
  try {
    state.tx(() => {
      need(!state.getControl("write:pending"), "WRITE_RESULT_UNKNOWN");
      idle(state);
      state.resume();
    });
    return { accountId: p.accountId, pauseCleared: true };
  } finally {
    state.close();
  }
}

export class Writer {
  constructor(config, localStore, network) {
    this.config = config;
    this.local = localStore;
    this.network = network;
  }
  async run(kind, args) {
    need(
      Object.keys(args).every((k) =>
        (kind === "history"
          ? ["readingId", "consumptionId"]
          : ["readingId", "folderId", "action"]
        ).includes(k),
      ),
      "UNKNOWN_PARAMETER",
    );
    const p = grant(this.config, kind);
    const reading = this.local.reading(args.readingId);
    need(
      p.allReadings === true || p.videos.includes(reading.bvid),
      "WRITE_TARGET_DENIED",
    );
    const auth = secrets(this.config.credentialPath);
    need(auth.session === this.network.secret, "WRITE_CREDENTIAL_CHANGED");
    const fingerprint = digest(p);
    const state = accountStore(this.config, p.accountId);
    let taskId;
    let intent;
    let failed = false;
    const n = this.network;
    const guard = () => {
      need(
        digest(grant(this.config, kind)) === fingerprint,
        "WRITE_GRANT_CHANGED",
      );
      need(
        digest(secrets(this.config.credentialPath)) === digest(auth),
        "WRITE_CREDENTIAL_CHANGED",
      );
      need(!state.getControl("pause"), "PERSISTENT_PAUSE");
      n.budget.check();
    };
    const get = (path, params = {}) =>
      n.request(new URL(API + path + "?" + new URLSearchParams(params)), "api");
    try {
      taskId = state.start();
      need(!state.getControl("write:pending"), "WRITE_RESULT_UNKNOWN");
      n.guard = guard;
      const nav = (await n.get(API + "/x/web-interface/nav")).data;
      need(
        nav?.isLogin === true && String(nav.mid) === p.accountId,
        "WRITE_ACCOUNT_MISMATCH",
      );
      const meta = (
        await n.get(
          API +
            "/x/web-interface/view?" +
            new URLSearchParams({ bvid: reading.bvid }),
        )
      ).data;
      const part = meta?.pages?.find((x) => x.page === reading.page);
      need(
        meta?.bvid === reading.bvid &&
          Number.isSafeInteger(meta.aid) &&
          meta.aid > 0 &&
          part?.cid === reading.cid &&
          part.duration === reading.duration,
        "WRITE_SOURCE_CHANGED",
      );
      let postPath, body, verify;
      if (kind === "history") {
        need(
          typeof args.consumptionId === "string" &&
            /^[a-f0-9-]{36}$/.test(args.consumptionId),
          "CONSUMPTION_REQUIRED",
        );
        const consumed = this.local.getControl(
          "consumption:" + args.consumptionId,
        );
        need(
          consumed?.confirmedBy === "local-human" &&
            consumed.readingId === args.readingId &&
            consumed.bvid === reading.bvid &&
            consumed.cid === reading.cid &&
            Number.isInteger(consumed.seconds) &&
            consumed.seconds > 0 &&
            consumed.seconds <= part.duration,
          "CONSUMPTION_REQUIRED",
        );
        const previous =
          state.getControl("history:" + reading.bvid + ":" + reading.cid) || 0;
        if (consumed.seconds <= previous)
          return { status: "already_recorded", seconds: previous };
        postPath = routes.historyPost;
        body = { aid: meta.aid, cid: reading.cid, progress: consumed.seconds };
        const lookup = async () =>
          (
            await get(routes.history, { type: "archive", ps: 30 })
          ).data?.list?.find(
            (x) =>
              x.history?.oid === meta.aid && x.history?.cid === reading.cid,
          );
        const existing = await lookup();
        if (
          existing &&
          (existing.progress >= consumed.seconds || existing.progress === -1)
        )
          return { status: "already_recorded", seconds: existing.progress };
        verify = async () => {
          const found = await lookup();
          need(
            found &&
              (found.progress >= consumed.seconds ||
                (found.progress === -1 && consumed.seconds === part.duration)),
            "WRITE_RECEIPT_MISMATCH",
          );
          state.setControl(
            "history:" + reading.bvid + ":" + reading.cid,
            consumed.seconds,
          );
        };
      } else {
        need(
          ["add", "remove"].includes(args.action) && numeric(args.folderId),
          "INVALID_FAVORITE_ACTION",
        );
        const folder = p.favorites.folders?.find((f) => f.id === args.folderId);
        need(
          folder && ["private", "public"].includes(folder.visibility),
          "FAVORITE_FOLDER_DENIED",
        );
        need(
          args.action !== "remove" || folder.allowRemove === true,
          "FAVORITE_REMOVE_DENIED",
        );
        const folders = async () => {
          const data = (
            await get(routes.folders, {
              up_mid: p.accountId,
              type: 2,
              rid: meta.aid,
            })
          ).data;
          const current = data?.list?.find(
            (f) => String(f.id) === args.folderId,
          );
          need(
            current &&
              String(current.mid) === p.accountId &&
              Number.isInteger(current.attr),
            "FAVORITE_FOLDER_DENIED",
          );
          need(
            (current.attr & 1 ? "private" : "public") === folder.visibility,
            "FAVORITE_VISIBILITY_CHANGED",
          );
          need(
            current.fav_state === 0 || current.fav_state === 1,
            "INVALID_FAVORITE_STATE",
          );
          return current.fav_state === 1;
        };
        const wanted = args.action === "add";
        if ((await folders()) === wanted)
          return { status: "already_in_desired_state", action: args.action };
        postPath = routes.favoritePost;
        body = {
          rid: meta.aid,
          type: 2,
          add_media_ids: wanted ? args.folderId : "",
          del_media_ids: wanted ? "" : args.folderId,
        };
        verify = async () =>
          need((await folders()) === wanted, "WRITE_RECEIPT_MISMATCH");
      }
      n.beforePost = () => {
        guard();
        state.tx(() => {
          const key = "quota:" + p.id + ":" + kind;
          const used = state.getControl(key) || 0;
          need(used < p[kind].maxWrites, "WRITE_QUOTA_EXHAUSTED");
          const last = state.getControl("write:last") || 0;
          need(Date.now() - last >= 60000, "WRITE_RATE_LIMIT");
          intent = {
            id: randomUUID(),
            kind,
            accountId: p.accountId,
            grantId: p.id,
            readingId: args.readingId,
            bvid: reading.bvid,
            cid: reading.cid,
            ...(kind === "favorites"
              ? { folderId: args.folderId, action: args.action }
              : { seconds: body.progress }),
            createdAt: now(),
            status: "pending",
          };
          state.setControl(key, used + 1);
          state.setControl("write:last", Date.now());
          state.setControl("write:pending", intent);
        });
      };
      await n.request(new URL(API + postPath), "api", {
        method: "POST",
        body: new URLSearchParams({ ...body, csrf: auth.csrf }),
        csrf: auth.csrf,
      });
      await verify();
      guard();
      state.tx(() => {
        state.setControl("write:receipt:" + intent.id, {
          ...intent,
          status: "verified",
          verifiedAt: now(),
        });
        state.setControl("write:pending", null);
      });
      return { id: intent.id, kind, status: "verified" };
    } catch (e) {
      failed = true;
      if (taskId && (intent || state.getControl("write:pending"))) {
        state.pause("WRITE_RESULT_UNKNOWN");
        this.local.pause("WRITE_RESULT_UNKNOWN");
        throw new Fault("WRITE_RESULT_UNKNOWN");
      }
      if (taskId && e.code === "WRITE_ACCOUNT_MISMATCH")
        this.local.pause("WRITE_ACCOUNT_MISMATCH");
      if (taskId && this.local.getControl("pause"))
        state.pause(this.local.getControl("pause").reason);
      throw e;
    } finally {
      n.guard = null;
      n.beforePost = null;
      if (taskId)
        state.finish(
          taskId,
          state.getControl("write:pending")
            ? "interrupted"
            : failed
              ? "failed"
              : "completed",
        );
      state.close();
    }
  }
}

export function writeStatus(config) {
  const switches = {
    history: config.enableHistoryWrites === true,
    favorites: config.enableFavoriteWrites === true,
  };
  const tools = [
    ...(switches.history ? ["bili_humanism_history"] : []),
    ...(switches.favorites ? ["bili_humanism_favorite"] : []),
  ];
  if (!tools.length) return { switches, platformWriteTools: tools };
  let state;
  try {
    const p = jsonFile(config.writePolicyPath, "WRITE_POLICY_INVALID");
    state = accountStore(config, p.accountId);
    return {
      switches,
      platformWriteTools: tools,
      accountId: p.accountId,
      grantId: p.id,
      expiresAt: p.expiresAt,
      pause: state.getControl("pause"),
      pending: state.getControl("write:pending"),
      recent: state.db
        .prepare(
          "SELECT value FROM control WHERE key LIKE 'write:receipt:%' ORDER BY rowid DESC LIMIT 10",
        )
        .all()
        .map((x) => JSON.parse(x.value)),
    };
  } catch (e) {
    return {
      switches,
      platformWriteTools: tools,
      error: e instanceof Fault ? e.code : "WRITE_STATE_UNAVAILABLE",
    };
  } finally {
    state?.close();
  }
}
