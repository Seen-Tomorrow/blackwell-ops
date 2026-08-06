/**
 * Leakage / policy unit tests — ENGINE-CONFIG-MODES §8.
 * Pure modules only; no React / localStorage.
 */
import { describe, expect, it } from "vitest";
import type { UserEditedTemplateParam } from "./types";
import {
  JOE_FULL_AUTO_DEFAULTS,
  filterValuesToKeySet,
  getLaunchPolicy,
  mergeLaunchValues,
  resolveLaunchKeySet,
  resolveLaunchPolicyId,
  resolveSmartBatchPush,
  seedFullAutoProfile,
} from "./launchPolicy";
import { migrateCatalogOverrideStore } from "./launchProfiles";
import { buildLaunchConfig, factoryDefaultsFromParams } from "./buildLaunchConfig";
import { pickHighNumeric } from "./multiAgentBooster";

function param(
  key: string,
  values: (string | number)[],
  opts?: Partial<UserEditedTemplateParam>,
): UserEditedTemplateParam {
  return {
    key,
    label: key.toUpperCase(),
    values,
    order: 0,
    hidden: false,
    defaultValue: values[0],
    factoryDefault: values[0],
    flag: `--${key.replace(/_/g, "-")}`,
    ptype: "arg_select",
    ui_group: "PERFORMANCE",
    note: "",
    ...opts,
  };
}

const template: UserEditedTemplateParam[] = [
  param("ctx", [8192, 32768], { ui_group: "SYSTEM", dock: "ctx" }),
  param("parallel", [1, 4, 8], { ui_group: "SYSTEM" }),
  param("kv_quant", ["q4_0", "q8_0", "f16"], { ui_group: "SYSTEM" }),
  param("reasoning", ["off", "on", 2000, 4000], { ui_group: "SYSTEM" }),
  param("vision", ["off", "auto", "on"], { ui_group: "FEATURE-FLAGS" }),
  param("flash_attn", ["off", "on"], { ui_group: "FEATURE-FLAGS" }),
  param("load_mode", ["mmap", "mlock"], { ui_group: "FEATURE-FLAGS" }),
  param("temp", [0.6, 0.8, 1.0], { ui_group: "SAMPLING", essential: false }),
  param("batch", [512, 2048, 8192, 16384], { essential: true }),
  param("ubatch", [256, 512, 2048], { essential: true }),
  param("split", ["none", "layer"], { ui_group: "SYSTEM" }),
  param("offload_mode", ["regular", "moe_optimal"], { ui_group: "SYSTEM" }),
  param("base_port", [8080], { ui_group: "SYSTEM", dock: "port" }),
  param("device", ["GPU-0", "GPU-1"], { ui_group: "MULTI-GPU" }),
];

const factoryDefaults = factoryDefaultsFromParams(template);
const essentialKeys = new Set(["device", "ctx", "batch", "ubatch", "base_port"]);

describe("resolveLaunchPolicyId", () => {
  it("maps FIT ON → full_auto", () => {
    expect(resolveLaunchPolicyId({ fullAutoMode: true, configView: "full" })).toBe("full_auto");
    expect(resolveLaunchPolicyId({ fullAutoMode: true, configView: "essentials" })).toBe("full_auto");
  });
  it("maps Assisted essentials / full", () => {
    expect(resolveLaunchPolicyId({ fullAutoMode: false, configView: "essentials" })).toBe(
      "assisted_essentials",
    );
    expect(resolveLaunchPolicyId({ fullAutoMode: false, configView: "full" })).toBe("assisted_full");
  });
});

describe("§8 leakage cases", () => {
  it("1: Assisted Full mlock does not seed Full Auto load_mode", () => {
    const legacy = {
      load_mode: "mlock",
      temp: 1.0,
      batch: 16384,
      vision: "auto",
      parallel: 8,
      kv_quant: "q8_0",
    };
    const fullAuto = seedFullAutoProfile({ legacyValues: legacy, factoryDefaults });
    expect(fullAuto.load_mode).toBe("mmap");
    expect(fullAuto.vision).toBe("off"); // Joe default — not "auto" from Assisted
    expect(fullAuto.parallel).toBe(8); // cockpit kept
    expect(fullAuto.temp).toBe(factoryDefaults.temp); // not 1.0 from Assisted
    expect(fullAuto.batch).not.toBe(16384); // not power batch residue
  });

  it("1b: Full Auto launch emits mmap not mlock from Assisted profile bag", () => {
    const assisted = { load_mode: "mlock", parallel: 1, kv_quant: "q8_0", ctx: 8192 };
    // Wrong bag (would be the old shared map) — Full Auto must still force Joe via merge
    const policy = getLaunchPolicy("full_auto");
    // Correct profile after seed:
    const profile = seedFullAutoProfile({
      legacyValues: assisted,
      factoryDefaults,
    });
    const merged = mergeLaunchValues({
      policy,
      factoryDefaults,
      profileValues: profile,
      cockpitLive: { parallel: 1 },
    });
    expect(merged.load_mode).toBe("mmap");

    const keys = resolveLaunchKeySet({
      policy,
      essentialFactoryKeys: essentialKeys,
      specActive: false,
      allParams: template,
    });
    const filtered = filterValuesToKeySet(merged, keys);
    expect(filtered.load_mode).toBe("mmap");
    expect(String(filtered.load_mode)).not.toBe("mlock");
  });

  it("2: Smart batch is ephemeral (resolveSmartBatchPush only when policy allows)", () => {
    const policy = getLaunchPolicy("full_auto");
    const push = resolveSmartBatchPush({
      policy,
      pushBatch: true,
      batchValues: [512, 2048, 16384],
      ubatchValues: [256, 512, 2048],
      pickHigh: pickHighNumeric,
    });
    expect(push.batch).toBe(16384);
    expect(push.ubatch).toBe(2048);

    const power = getLaunchPolicy("assisted_full");
    const noPush = resolveSmartBatchPush({
      policy: power,
      pushBatch: true,
      batchValues: [512, 16384],
      ubatchValues: [256, 2048],
      pickHigh: pickHighNumeric,
    });
    expect(noPush.batch).toBeUndefined();
    expect(noPush.ubatch).toBeUndefined();
  });

  it("3: Full Auto Think 2k sets reasoning budget; never forces vision", () => {
    const policy = getLaunchPolicy("full_auto");
    const profile = seedFullAutoProfile({
      legacyValues: { reasoning: 2000, parallel: 1 },
      factoryDefaults,
    });
    const merged = mergeLaunchValues({
      policy,
      factoryDefaults,
      profileValues: profile,
      cockpitLive: { reasoning: 2000, parallel: 1 },
    });
    expect(merged.reasoning).toBe(2000);
    expect(merged.vision).toBe(JOE_FULL_AUTO_DEFAULTS.vision);
    expect(merged.vision).toBe("off");
  });

  it("4: Header VISION ON survives cockpit merge (not overwritten by Agents)", () => {
    const policy = getLaunchPolicy("full_auto");
    const profile = {
      ...seedFullAutoProfile({ legacyValues: {}, factoryDefaults }),
      vision: "on",
    };
    // Cockpit plan only writes parallel/kv/reasoning — vision stays from profile
    const merged = mergeLaunchValues({
      policy,
      factoryDefaults,
      profileValues: profile,
      cockpitLive: { parallel: 8, kv_quant: "q4_0", reasoning: "on" },
    });
    expect(merged.vision).toBe("on");
    expect(merged.parallel).toBe(8);
  });

  it("5: Assisted Full temp=1.0 does not appear on Full Auto essentials key set", () => {
    const policy = getLaunchPolicy("full_auto");
    // Even if temp sneaks into merged values, key set filters it out
    const merged = mergeLaunchValues({
      policy,
      factoryDefaults,
      profileValues: { temp: 1.0, ctx: 8192, parallel: 1 },
    });
    const keys = new Set(
      resolveLaunchKeySet({
        policy,
        essentialFactoryKeys: essentialKeys,
        specActive: false,
        allParams: template,
      }),
    );
    const filtered = filterValuesToKeySet(merged, keys);
    expect(filtered.temp).toBeUndefined();
    expect(keys.has("temp")).toBe(false);
  });

  it("5b: Assisted Full key set includes temp", () => {
    const policy = getLaunchPolicy("assisted_full");
    const keys = resolveLaunchKeySet({
      policy,
      essentialFactoryKeys: essentialKeys,
      specActive: false,
      allParams: template,
    });
    expect(keys).toContain("temp");
  });

  it("6: Full Auto topology is fit_owned (offload forced regular; device/split not from Assisted)", () => {
    const policy = getLaunchPolicy("full_auto");
    expect(policy.topology).toBe("fit_owned");
    const merged = mergeLaunchValues({
      policy,
      factoryDefaults,
      profileValues: {
        device: "GPU-1",
        split: "layer",
        offload_mode: "moe_optimal",
      },
    });
    expect(merged.offload_mode).toBe("regular");
    // device/split may still be in bag; FIT builder ignores them in fullAutoMode
    const seeded = seedFullAutoProfile({
      legacyValues: { device: "GPU-1", split: "layer", offload_mode: "moe_optimal" },
      factoryDefaults,
    });
    expect(seeded.device).toBeUndefined();
    expect(seeded.split).toBeUndefined();
    expect(seeded.offload_mode).toBe("regular");
  });
});

describe("migrateCatalogOverrideStore", () => {
  it("copies flat bag to assisted; seeds slim full_auto", () => {
    const flat = { load_mode: "mlock", temp: 1.0, parallel: 4, batch: 16384 };
    const store = migrateCatalogOverrideStore({
      raw: flat,
      factoryDefaults,
      preferredActive: "full_auto",
    });
    expect(store.version).toBe(2);
    expect(store.profiles.assisted_full.load_mode).toBe("mlock");
    expect(store.profiles.assisted_full.temp).toBe(1.0);
    expect(store.profiles.full_auto.load_mode).toBe("mmap");
    expect(store.profiles.full_auto.parallel).toBe(4);
    expect(store.profiles.full_auto.temp).not.toBe(1.0);
  });

  it("is idempotent on v2", () => {
    const once = migrateCatalogOverrideStore({
      raw: { load_mode: "mlock", parallel: 2 },
      factoryDefaults,
    });
    const twice = migrateCatalogOverrideStore({
      raw: once,
      factoryDefaults,
    });
    expect(twice.profiles.full_auto.load_mode).toBe(once.profiles.full_auto.load_mode);
    expect(twice.profiles.assisted_full.load_mode).toBe("mlock");
  });
});

describe("buildLaunchConfig policy metadata", () => {
  it("tags extra_params with __launch_policy", () => {
    const model = {
      path: "C:/models/test.gguf",
      author: "t",
      name: "test",
      quant: "Q4",
      size_str: "1G",
      vision: false,
      // no metadata → non-FIT simple path
    };
    const cfg = buildLaunchConfig({
      model,
      finalAlias: "test",
      profileValues: {
        ...seedFullAutoProfile({ legacyValues: { parallel: 1 }, factoryDefaults }),
        ctx: 8192,
      },
      policy: getLaunchPolicy("full_auto"),
      smartBatchPush: false,
      effectiveBackendType: "ggml-master",
      selectedBinaryProfile: "frontier",
      fitLaunchSupported: false,
      essentialFactoryKeys: essentialKeys,
      allParamsResolved: template,
      gpus: [],
      runningSlotsForPlan: [],
      vramManifest: null,
      testFlagsEnabled: false,
      testFlags: "",
      testFlagsMode: "add",
    });
    expect(cfg.extra_params?.__launch_policy).toBe("full_auto");
    expect(cfg.extra_params?.__memory_mode).toBe("full_auto");
    expect(cfg.extra_params?.load_mode).toBe("mmap");
    expect(cfg.extra_params?.temp).toBeUndefined();
  });

  it("Smart batch injects high batch only for full_auto + smartBatchPush", () => {
    const model = {
      path: "C:/models/test.gguf",
      author: "t",
      name: "test",
      quant: "Q4",
      size_str: "1G",
      vision: false,
    };
    const withSmart = buildLaunchConfig({
      model,
      finalAlias: "test",
      profileValues: seedFullAutoProfile({ legacyValues: { parallel: 1 }, factoryDefaults }),
      policy: getLaunchPolicy("full_auto"),
      smartBatchPush: true,
      effectiveBackendType: "ggml-master",
      selectedBinaryProfile: "frontier",
      fitLaunchSupported: false,
      essentialFactoryKeys: essentialKeys,
      allParamsResolved: template,
      gpus: [],
      runningSlotsForPlan: [],
      vramManifest: null,
      testFlagsEnabled: false,
      testFlags: "",
      testFlagsMode: "add",
    });
    expect(withSmart.extra_params?.batch).toBe(16384);

    const assisted = buildLaunchConfig({
      model,
      finalAlias: "test",
      profileValues: { batch: 512, parallel: 1, temp: 1.0 },
      policy: getLaunchPolicy("assisted_full"),
      smartBatchPush: true, // ignored for power policy
      effectiveBackendType: "ggml-master",
      selectedBinaryProfile: "frontier",
      fitLaunchSupported: false,
      essentialFactoryKeys: essentialKeys,
      allParamsResolved: template,
      gpus: [],
      runningSlotsForPlan: [],
      vramManifest: null,
      testFlagsEnabled: false,
      testFlags: "",
      testFlagsMode: "add",
    });
    expect(assisted.extra_params?.batch).toBe(512);
    expect(assisted.extra_params?.temp).toBe(1.0);
  });
});
