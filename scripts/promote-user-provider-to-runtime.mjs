#!/usr/bin/env node
/**
 * Promote a user provider config to src-tauri/runtime/{id}/config/{id}-default-config.json
 * for optional App-update distribution (templates only; engines via provider pack).
 *
 * Usage:
 *   node scripts/promote-user-provider-to-runtime.mjs bee-llama
 *   node scripts/promote-user-provider-to-runtime.mjs bee-llama --user-config path/to/user.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const providerId = process.argv[2];
if (!providerId) {
  console.error("Usage: node scripts/promote-user-provider-to-runtime.mjs <provider-id> [--user-config path]");
  process.exit(1);
}

const userConfigFlag = process.argv.indexOf("--user-config");
const defaultUserPath = path.join(
  root,
  "src-tauri",
  "target",
  "debug",
  "config",
  `${providerId}-user-config.json`,
);
const userPath =
  userConfigFlag >= 0 ? process.argv[userConfigFlag + 1] : defaultUserPath;

if (!fs.existsSync(userPath)) {
  console.error(`User config not found: ${userPath}`);
  console.error("Export does NOT write runtime/ — it only updates an existing factory file for bundled providers.");
  console.error("Use this script after testing a custom provider in-app.");
  process.exit(1);
}

const user = JSON.parse(fs.readFileSync(userPath, "utf8"));

function userParamToFactory(p) {
  const out = {
    key: p.key,
    label: p.label,
    values: p.values ?? [],
    default: p.defaultValue ?? p.factoryDefault ?? p.values?.[0] ?? null,
    hidden_default: !!(p.hidden ?? p.userHidden),
    flag: p.flag ?? null,
    flag_pair: p.flag_pair ?? [],
    ptype: p.ptype,
    step: p.step ?? null,
    ui_group: p.ui_group ?? "SYSTEM",
    note: p.note ?? "",
    pattern: p.pattern ?? "",
    dock: p.dock ?? "",
  };
  if (p.sub_params) out.sub_params = p.sub_params;
  return out;
}

const params = (user.userEditedTemplateParams ?? [])
  .slice()
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map(userParamToFactory);

const layoutDefaults = {
  configColumnCount: user.configColumnCount ?? 2,
  configColumnWidths: user.configColumnWidths ?? [0.5, 0.5],
  groupDisplayZone: user.groupDisplayZone ?? {},
  groupColumn: user.groupColumn ?? {},
  aboveColumnWidths: user.aboveColumnWidths ?? [0.4, 0.6],
};

const factory = {
  id: providerId,
  display_name: user.display_name || providerId,
  description: user.description || `Optional engine fork (${providerId})`,
  binary_name: "llama-server.exe",
  git_url: user.git_url || "",
  branch: user.branch || "main",
  build_profile: user.build_profile || "",
  template_type: user.template_type || "ggml-llama",
  optionalDownload: true,
  groupOrder: user.groupOrder ?? ["ABOVE-CONFIG-LEFT", "ABOVE-CONFIG-RIGHT", "PERFORMANCE", "SYSTEM"],
  layoutDefaults,
  // Full Master spawn_profile when user config has a stub / empty fit_style.
  spawn_profile: (() => {
    const masterPath = path.join(
      root,
      "src-tauri",
      "runtime",
      "ggml-master",
      "config",
      "ggml-master-default-config.json",
    );
    let masterSpawn = {};
    try {
      if (fs.existsSync(masterPath)) {
        masterSpawn = JSON.parse(fs.readFileSync(masterPath, "utf8")).spawn_profile ?? {};
      }
    } catch {
      /* ignore */
    }
    const userSp = user.spawn_profile ?? {};
    const hasFit =
      typeof userSp.fit_style === "string" && userSp.fit_style.trim().length > 0;
    if (hasFit) return userSp;
    return {
      ...masterSpawn,
      ...userSp,
      fit_adapter: userSp.fit_adapter || "ggml_master",
      fusion_adapter: userSp.fusion_adapter || "ggml_master",
      fit_style: userSp.fit_style || masterSpawn.fit_style || "ggml_fit_params",
    };
  })(),
  templateVersion: 1,
  params,
};

const outDir = path.join(root, "src-tauri", "runtime", providerId, "config");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${providerId}-default-config.json`);
fs.writeFileSync(outPath, JSON.stringify(factory, null, 2) + "\n", "utf8");
console.log(`[promote] Wrote ${outPath} (${params.length} params, optionalDownload=true)`);