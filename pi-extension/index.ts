import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { connect, type Socket } from "node:net";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const SOCK = "/tmp/pi-companion.sock";
const SESSION_ID = randomUUID().slice(0, 8);
const COMPANION_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "companion.mjs"
);
const SETTINGS_PATH = join(homedir(), ".pi", "companion.json");

function loadEnabled(): boolean {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return data.enabled !== false;
  } catch {
    return true;
  }
}

function saveEnabled(value: boolean) {
  try {
    let data: any = {};
    try {
      data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    } catch {}
    data.enabled = value;
    writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
  } catch {}
}

export default function (pi: ExtensionAPI) {
  let enabled = loadEnabled();
  let sock: Socket | null = null;
  let lastStatus = "";
  let lastCtx: any = null;
  const project = basename(process.cwd());

  // ── socket helpers ────────────────────────────────────────────────────────

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
    const child = spawn("node", [COMPANION_PATH], {
      detached: true,
      stdio: "ignore",
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
    saveEnabled(true);
    await ensureConnected();
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      "companion",
      theme.fg("accent", "G") + theme.fg("dim", " ·")
    );
  }

  function disable(ctx: any) {
    enabled = false;
    saveEnabled(false);
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
    description: "Toggle cursor companion (shows agent activity near cursor)",
    handler: async (_args, ctx) => {
      if (enabled) {
        disable(ctx);
        ctx.ui.notify("Companion disabled", "info");
      } else {
        await enable(ctx);
        ctx.ui.notify("Companion enabled", "info");
      }
    },
  });

  // ── event handlers ────────────────────────────────────────────────────────

  pi.on("agent_start", async (_event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    await ensureConnected();
    send("starting");
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    send("done");
    setTimeout(() => {
      if (lastStatus === "done") sendRemove();
    }, 3000);
  });

  pi.on("message_update", async (_event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    if (lastStatus === "thinking") return;
    send("thinking");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!enabled) return;
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
    if (!enabled) return;
    lastCtx = ctx;
    if (event.isError) {
      send("error", event.toolName);
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    disconnect();
  });
}
