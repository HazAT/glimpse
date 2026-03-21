import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { connect, type Socket } from "node:net";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { getCompanionSocketPath } from "./socket-path.mjs";
import { getFollowCursorSupport } from "../src/glimpse.mjs";

const SOCK = getCompanionSocketPath();
const SESSION_ID = randomUUID().slice(0, 8);
const COMPANION_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "companion.mjs"
);
const SETTINGS_PATH = join(homedir(), ".pi", "companion.json");

type CompanionMode = "follow" | "static";

function loadSettings(): { enabled: boolean; mode: CompanionMode } {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return {
      enabled: data.enabled === true,
      mode: data.mode === "static" ? "static" : "follow",
    };
  } catch {
    return { enabled: false, mode: "follow" };
  }
}

function saveSetting(key: string, value: any) {
  try {
    let data: any = {};
    try {
      data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    } catch {}
    data[key] = value;
    writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
  } catch {}
}

export default function (pi: ExtensionAPI) {
  const settings = loadSettings();
  let enabled = settings.enabled;
  let mode: CompanionMode = settings.mode;
  let sock: Socket | null = null;
  let lastStatus = "";
  let lastCtx: any = null;
  let warnedUnsupported = false;
  const followCursorSupport = getFollowCursorSupport();
  const project = basename(process.cwd());

  // ── helpers ────────────────────────────────────────────────────────────────

  function maybeNotifyUnsupported(ctx: any) {
    if (followCursorSupport.supported || warnedUnsupported) return;
    warnedUnsupported = true;
    ctx.ui.notify(`Companion disabled on this platform: ${followCursorSupport.reason}`, "info");
  }

  function send(status: string, detail?: string) {
    lastStatus = status;
    if (!sock || sock.destroyed) return;
    const msg: any = { id: SESSION_ID, project, status, detail };
    if (lastCtx) {
      try {
        const usage = lastCtx.getContextUsage();
        if (usage && usage.percent != null) {
          msg.contextPercent = Math.round(usage.percent);
        }
      } catch {}
    }
    sock.write(JSON.stringify(msg) + "\n");
  }

  function sendRemove() {
    if (!sock || sock.destroyed) return;
    sock.write(JSON.stringify({ id: SESSION_ID, type: "remove" }) + "\n");
    lastStatus = "";
  }

  function connectToCompanion(): Promise<void> {
    return new Promise((resolve) => {
      sock = connect(SOCK, () => resolve());
      sock.on("error", () => {
        sock = null;
        resolve();
      });
      sock.on("close", () => {
        sock = null;
      });
    });
  }

  async function ensureConnected() {
    if (sock && !sock.destroyed) return;

    // Try connecting to existing companion
    await connectToCompanion();
    if (sock) return;

    // Spawn companion and retry
    const args = [COMPANION_PATH, ...(mode === "follow" ? ["--follow"] : [])];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
    });
    child.unref();

    // Wait for socket to be available
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await connectToCompanion();
      if (sock) return;
    }
  }

  function disconnect() {
    if (sock && !sock.destroyed) {
      sendRemove();
      sock.end();
    }
    sock = null;
    lastStatus = "";
  }

  // ── enable / disable ──────────────────────────────────────────────────────

  async function enable(ctx: any) {
    enabled = true;
    saveSetting("enabled", true);
    if (mode === "follow" && !followCursorSupport.supported) {
      maybeNotifyUnsupported(ctx);
      ctx.ui.setStatus("companion", undefined);
      return;
    }
    await ensureConnected();
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      "companion",
      theme.fg("accent", "G") + theme.fg("dim", " ·")
    );
  }

  function disable(ctx: any) {
    enabled = false;
    saveSetting("enabled", false);
    disconnect();
    ctx.ui.setStatus("companion", undefined);
  }

  // ── session start ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (enabled) {
      await enable(ctx);
    }
  });

  // ── /companion command ────────────────────────────────────────────────────

  pi.registerCommand("companion", {
    description:
      "Toggle companion or set mode: /companion, /companion follow, /companion static",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      if (arg === "follow" || arg === "static") {
        const newMode = arg as CompanionMode;
        if (newMode !== mode) {
          mode = newMode;
          saveSetting("mode", mode);
          // Restart companion with new mode
          disconnect();
          if (enabled) {
            await enable(ctx);
            ctx.ui.notify(`Companion mode: ${mode}`, "info");
          }
        } else {
          ctx.ui.notify(`Already in ${mode} mode`, "info");
        }
        return;
      }

      if (enabled) {
        disable(ctx);
        ctx.ui.notify("Companion disabled", "info");
      } else {
        await enable(ctx);
        if (mode === "static" || followCursorSupport.supported) {
          ctx.ui.notify(`Companion enabled (${mode})`, "info");
        }
      }
    },
  });

  // ── event handlers ────────────────────────────────────────────────────────

  function isActive() {
    if (!enabled) return false;
    if (mode === "follow" && !followCursorSupport.supported) return false;
    return true;
  }

  pi.on("agent_start", async (_event, ctx) => {
    if (!isActive()) return;
    lastCtx = ctx;
    await ensureConnected();
    send("starting");
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isActive()) return;
    lastCtx = ctx;
    send("done");
    setTimeout(() => {
      if (lastStatus === "done") sendRemove();
    }, 3000);
  });

  pi.on("message_update", async (_event, ctx) => {
    if (!isActive()) return;
    lastCtx = ctx;
    if (lastStatus === "thinking") return;
    send("thinking");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!isActive()) return;
    lastCtx = ctx;
    const { toolName, args = {} } = event;

    switch (toolName) {
      case "read":
        send("reading", basename(args.path ?? ""));
        break;
      case "edit":
      case "write":
        send("editing", basename(args.path ?? ""));
        break;
      case "bash":
        send("running", args.command ?? "");
        break;
      case "grep":
      case "find":
      case "ls":
        send("searching", args.pattern ?? args.path ?? "");
        break;
      default:
        send("running", toolName);
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!isActive()) return;
    lastCtx = ctx;
    if (event.isError) {
      send("error", event.toolName);
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    disconnect();
  });
}
