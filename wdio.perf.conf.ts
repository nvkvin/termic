// Nightly performance run. Same stack as wdio.conf.ts (real macOS WKWebView
// window via @wdio/tauri-service) but a separate spec set, a separate profile,
// and a JSON report instead of pass/fail.
//
// NOT run on PRs. The metrics here are durations and memory, which a 3-core
// virtualised runner cannot resolve tightly enough to gate a merge on. The
// argument, and what IS gated per-PR instead, is in docs/perf-ci.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { flush, resetCollector } from "./perf/nightly/report.js";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.join(repoRoot, "src-tauri", "target", "debug", process.platform === "win32" ? "termic.exe" : "termic");

export const dataDir = path.join(repoRoot, ".e2e", "profile");
const reportPath =
  process.env.TERMIC_PERF_REPORT ?? path.join(repoRoot, ".perf", "report.json");

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: path.join(repoRoot, "e2e", "tsconfig.json"),

  specs: [path.join(repoRoot, "perf", "nightly", "specs", "**", "*.perf.ts")],
  // Serial for the same reason as the e2e suite, and additionally because two
  // app instances on one runner would contaminate every number here.
  maxInstances: 1,

  // Vendor capability extension, unknown to WebdriverIO's types. See wdio.conf.ts.
  capabilities: [
    { browserName: "tauri", "tauri:options": { application: appBinary } } as WebdriverIO.Capabilities,
  ],
  services: [
    ["@wdio/tauri-service", { appBinaryPath: appBinary, driverProvider: "embedded" }],
  ],

  framework: "mocha",
  reporters: ["spec"],
  logLevel: "silent",
  // Generous: a memory spec opens and closes tasks in a loop, and a slow
  // runner must produce a number rather than a timeout.
  mochaOpts: { ui: "bdd", timeout: 300_000 },
  waitforTimeout: 30_000,
  waitforInterval: 100,

  onPrepare() {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    process.env.TERMIC_DATA_DIR = dataDir;
    // Linux: WebKitGTK's localStorage lives under $XDG_DATA_HOME, shared with
    // the developer's installed Termic unless the run gets its own. See the
    // same block in wdio.conf.ts.
    if (process.platform === "linux") {
      process.env.XDG_DATA_HOME = path.join(dataDir, "xdg-data");
      process.env.XDG_CACHE_HOME = path.join(dataDir, "xdg-cache");
      mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
      mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
    }
    // Workers inherit this, and both sides resolve the handoff file from it.
    process.env.TERMIC_PERF_NDJSON ??= path.join(repoRoot, ".perf", "rows.ndjson");
    resetCollector();
    try {
      for (const f of readdirSync(path.join(dataDir, "tasks"))) {
        if (f.endsWith(".json")) rmSync(path.join(dataDir, "tasks", f), { force: true });
      }
    } catch {
      /* no tasks dir yet */
    }
  },

  onComplete() {
    flush(reportPath);
  },
};
