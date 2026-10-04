# SPEC-ADAPTERS — speculative decoding architecture

**Status: design proposal, not implemented.** Written 2026-10 before any code change beyond the
two noted below. This is the reference for the redesign; it is not a description of current
behaviour except where it is citing it as a problem.

Already done, referenced here so it is not re-litigated:

- `AGENTS.md` → *No real users yet — never write migration code*. **No backward-compatibility
  work in this redesign.** No shims, no legacy keys, no dual-read, no aliases. Delete the old shape.
- `specTypeAllowsParallel` no longer hardcodes `draft-mtp` as single-slot. The blocking set is
  empty pending measurement — see *Open questions* Q1.

---

## 1. Why this needs a redesign, with evidence

### 1.1 Five vocabularies for one concept

| Axis | Values | Owner |
|---|---|---|
| Product Boost | `off \| mtp \| dflash \| dspark` | `SpecBoostMethod`, `specProfiles.ts` |
| CLI type | `draft-mtp \| draft-dflash \| draft-dspark \| draft-eagle3` | `cliSpecTypeForMethod` if-chain |
| Catalog role | `none \| mtp_embedded \| external_dflash \| external_eagle3 \| external_mtp` | `DraftRole`, `specDraft.ts` |
| Capability | `mtp \| dflash \| eagle3` | `SpecCapability`, `specDraft.ts` |
| Template group + knob prefix | `SPECULATIVE-MTP`/`mtp_` · `SPECULATIVE-DFLASH`/`dflash_` | templates, `systemParams.ts` |

The mappings between them are hand-written if-chains. `specDraft.ts` is 677 lines and roughly a
third is enum→enum translation.

### 1.2 The coupling number

129 literal occurrences of the four CLI spec-type strings across 16 files (top of list):

```
38  src/lib/specDraft.ts              8  src/hooks/useCockpit.ts
15  src-tauri/src/spec_draft.rs       7  src-tauri/src/fusion/adapters/parse_ggml.rs
 8  src-tauri/src/templates.rs        7  src/lib/multiAgentBooster.ts
 8  src-tauri/src/vram_learn.rs       6  src/components/MultiAgentBooster.tsx
 8  src/components/EngineConfigPanel  6  src/lib/specProfiles.ts
 5  src-tauri/src/engine.rs           4  src/components/EngineParamGroups.tsx
```

A proxy for coupling, not an exact edit count — but it is the right order of magnitude for
"what does adding a method cost today".

### 1.3 EAGLE3 is the proof, not a proposal

`draft-eagle3` has a `DraftRole`, a `SpecCapability`, a `DRAFT_ARCH_FOR_SPEC` entry, and 25
literal mentions in `specDraft.ts` — but **no `SpecBoostMethod` value and no template group**.
`specCapabilitiesForMain` can return `"eagle3"` and `defaultSpecTypeForMain` can return
`"draft-eagle3"`, yet Boost can never select it. A method is half-present in four of five axes and
unreachable from the UI. That is what scattering per-method edits produces.

### 1.4 The live bug this design fixes

External MTP draft files are launched with the **wrong spec method**:

- `specCapabilitiesForMain` maps external-MTP candidates to `caps.push("dflash")`.
- `DRAFT_ARCH_FOR_SPEC` has no `"draft-mtp"` key → `draftRoleForSpecType("draft-mtp")` returns
  `null` → MTP cannot resolve, persist, or validate a draft pairing.
- `buildSpecCliExtraParams` emits a draft path **only** in the `dflash`/`dspark` branch.
- `specTypeNeedsExternalDraft` explicitly excludes `draft-mtp`.

Net: an MTP draft GGUF goes out as `--spec-type draft-dflash`. Upstream MTP with `-md` is
unrepresentable in the current model.

### 1.5 The classifier exists twice and has already drifted

`spec_draft.rs::classify_draft_role` and `specDraft.ts::draftRoleFromModel` implement the same
rules independently, ~1,340 lines total, synced by hand. Confirmed divergences:

- **DSpark does not exist in Rust.** Zero occurrences of `dspark` in `spec_draft.rs`; TS checks it
  first in `pathIdentityDraftRole`. Same file, two verdicts.
- **TS-only rules with no Rust counterpart:** `n_layer <= 12` + `"draft"` in haystack → DFlash;
  haystack-dflash match.
- **Feedback loop.** Rust writes `draft_role` / `draft_role_hint`; TS *reads both back* as
  classifier inputs (`parseDraftRoleHint`, `meta.draft_role`), and does so **before** the nextn
  heuristics. A stale cached role pins the TS answer and suppresses a better one.
- **The catalog "Regular" filter answers from two sources** — Rust
  `is_external_draft_role_hint(hint) || is_launchable_target(...)` vs TS
  `!isExternalDraftOnly(m)`. Two independent verdicts on the same row.
- **A third MTP detector** with looser rules: `tomMtp.isMtpModel` matches `hfId.includes("mtp")`
  and `path.includes("-mtp-")`, which `specDraft` deliberately does not.
- Byte-identical duplicated constants: the 10 GiB literal `10_737_418_240` and the whole
  `isPlausibleFullModelSize` body (`paramsB * 0.31 * 0.5`) exist in both languages.

### 1.6 Detection is naming archaeology because the scanner is blind

`gguf_scan.rs` is **not a GGUF parser**. It spawns `llama-server -m <path> -ngl 0 -t 1 --fit off`
with `-lv 4`, scrapes stderr, and kills the child at `load_tensors:` under a 15 s wall clock. It
gets KV metadata, `print_info`, and a **quant-type histogram** (`tensor_counts`). It never sees
**tensor names**.

Consequences:

- The structural signal that actually distinguishes a draft — `blk.N.nextn.*`, `dflash.*`,
  `markov_w1.weight`, trunk tensors — is invisible.
- `vocab_size` is scraped from a printed token-array length, not read. A head carrying
  `added_tokens` but no `tokens` array yields `vocab_size == 0` and is classified a standalone head.
- KV values are clamped to 40 chars by the loader itself, so long values are unrecoverable at source.
- `file_size_bytes` is overwritten with the shard total before classification for sharded entries,
  so the size heuristic runs on a number that is not the scanned file.
- Every path segment is a classification signal, so a folder named `DFlash` marks every `.gguf`
  beneath it — including full main models.
- The entire external-MTP category rests on a dot vs a hyphen: `X.mtp.gguf` is a head,
  `-mtp.gguf` is a baked-in main.

The code admits this in three separate comments: *"The GGUF header has no role field that
distinguishes them."*

---

## 2. Target architecture

### 2.1 Spec adapter registry

Mirror the pattern already shipped twice in this repo — `fusion/adapters/` and `fit_adapters/`,
each selected by a string key in factory JSON (`spawn_profile.fusion_adapter`,
`spawn_profile.fit_adapter`).

```
src/lib/spec/adapters/
  mtp.ts   dflash.ts   dspark.ts   eagle3.ts
  index.ts        // SPEC_ADAPTERS: Record<string, SpecAdapter>
```

```ts
interface SpecAdapter {
  id: string                      // "mtp"          — product/Boost id
  cliType: string                 // "draft-mtp"    — --spec-type value
  label: string                   // "MTP"          — badge
  group: string                   // template group id
  knobs: {
    nMax: string; nMin: string; pMin: string
    draftModel?: string           // absent ⇒ method is baked-in only
  }
  draftRoles: DraftRole[]         // which catalog roles serve this method
  needsDraft(ctx): boolean
  allowsParallel(ctx): boolean
  detect?(shape: GgufShape): boolean
  memory?: {                      // forecast hooks, see 2.4
    additiveFromShape(shape: GgufShape): MemoryTerm[]
    learnedIncludesDraft(snapshot): boolean
  }
}
```

Collapses into registry lookups: `cliSpecTypeForMethod`, `groupForBoostMethod`,
`boostMethodForGroup`, `draftRoleForSpecType`, `defaultSpecTypeForMain`,
`specTypeNeedsExternalDraft`, `specTypeAllowsParallel`, `isSpecTypeValidForMain`,
`draftRoleBadge`, `essentialsSpecChipLabel`.

`buildSpecCliExtraParams` becomes generic — iterate `adapter.knobs`, emit each param's `flag`,
emit the draft path when `knobs.draftModel` is present. **This is how `draft-mtp` gets its `-md`
lane: not a new branch, just a knob the MTP adapter declares.**

Boost chips build from the registry intersected with the template's `spec_type` values, which
`MultiAgentBooster` already reads. Adding a method = one adapter file + one template group.

### 2.2 One classifier, Rust authoritative

Rust already computes the answer and ships it (`finalize_draft_role` → `meta.draft_role`).

- **Rust owns classification.** `classify_draft_role` is the only implementation.
- **TS consumes it.** `draftRoleFromModel` becomes: read `meta.draft_role`; if absent (unscanned
  file, catalog lag) apply a *path-hint fallback only*, clearly labelled as lower-confidence.
- **Delete the feedback loop.** TS must not feed `draft_role_hint` back in as a classifier input.
  Hint is an override surface for the user, not an intermediate value.
- **Fold DSpark into Rust** as a first-class role rather than a TS-only path sniff.
- **Pin the two sides with a shared fixture table**: a checked-in list of
  `{ GgufShape, path, expected_role }` run by both `cargo test` and vitest. Invariants, not
  snapshots — a case that needs editing because the rules legitimately changed is the wrong case.

### 2.3 `GgufShape` and the tensor reader

New Rust reader over the GGUF **tensor-info table** — name, n_dims, dims, type, offset records.
Header only; no tensor data touched; no engine spawned. Emits:

```rust
struct GgufShape {
    arch: String,
    block_count: u32,
    nextn_layers: u32,
    has_markov_w1: bool,      // DSpark sentinel
    has_trunk: bool,          // hc_attn_norm / full layer stack
    has_vocab: bool,
    shard_count: u32,
}
```

This is strictly cheaper and safer than the current engine-spawn scan, and it removes the
`vocab_size`-scraping and 40-char-truncation problems for the fields that matter.

**Sharding caveat:** each split carries only its own tensor-info list, so a complete classification
of a sharded draft needs every split's header (still header-only). Upstream `#26814` simply skips
sharded drafts; we should not.

### 2.4 Forecast hooks

Speculative decoding already reaches the VRAM forecast through one MTP-specific channel:
`launch_memory_parse.rs` parses `mtp_context_mib` from `common_speculative_init` + a second
`llama_kv_cache` line, and `ggml_master.ts` decides whether a learned measurement already includes
draft buffers with a bare magic number:

```ts
const learnedHasDraft = (input.learnedMtpContextMib ?? 0) > 64;
```

That is a per-method assumption living in a provider adapter. Under 2.1 it belongs to
`adapter.memory.learnedIncludesDraft`, and the term name should stop being MTP-specific once more
than one method can be external. Also verify: learned-memory identity keys must distinguish
spec-off / baked-MTP / external-draft, since an external draft's own footprint is a different
additive term from baked-in nextn buffers.

---

## 3. Classification rule table

Header-first, naming as fallback only. `block_count` is already captured today (→ `n_layer`);
the rest need the tensor reader.

| Header condition | Class | Needs tensor reader |
|---|---|---|
| `arch` is `dflash` **or** `dflash-draft`, and `markov_w1.weight` present | DSpark draft | yes |
| `arch` is `dflash`/`dflash-draft`, no Markov tensor | DFlash draft | partial |
| NextN tensors present, `block_count == 1`, trunk absent | external MTP draft | yes |
| NextN tensors present, full `block_count` | target with baked MTP | no |
| `arch` is `eagle3` | EAGLE3 draft | no |
| anything else | target, no MTP | no |

Notes:

- `dflash-draft` is a real-world arch string that upstream's registry rejects; accept it as an alias.
- MTP drafts usually keep the **target** architecture (`qwen35`, `qwen4exp`), which is why no role
  key ever appeared upstream — the converter treats a draft as a truncated copy. `block_count` is
  therefore the discriminator, not `arch`.
- Filename prefixes (`mtp-`, `shared-`, an `MTP/` folder) are a Hugging Face sidecar convention,
  not a GGUF field. Keep them as a **fallback tier below header evidence**, never above.
- Demote to fallback: the 10 GiB size rule, `vocab_size == 0`, `n_layer <= 12`, all path-segment
  sniffing. They stay for unscanned files and lose to any header evidence.

---

## 4. Build order

No data migration anywhere — see AGENTS.md. Each step is independently shippable.

1. **Tensor reader + `GgufShape`** (Rust, additive). Nothing consumes it yet.
2. **Rule table in Rust**, header-first; delete the TS classifier down to a path-hint fallback;
   add the shared fixture table. This is the step that removes ~600 duplicated lines.
3. **Registry** in TS; existing exported functions delegate to it; public names stay stable so the
   16 coupled files do not churn in one commit.
4. **`draft-mtp` external lane**: `draftModel` knob on the MTP adapter, `DRAFT_ARCH_FOR_SPEC`
   entry, `specCapabilitiesForMain` stops coercing MTP drafts to `dflash`. Template knob is added
   in-app by the owner, not in code.
5. **Forecast hooks** per 2.4.
6. **Rename** `useDflashDraft` → `useSpecDraft`, `dflashGetDraft` → `specGetDraft`. Last, because
   it is pure churn and should not ride with behaviour changes.
7. **Delete** `OBSOLETE_SPEC_PARAM_KEYS`, the `Repair mtp_*/dflash_*` branch, and the `systemParams`
   migrate path.

---

## 5. Open questions

**Q1 — does `-np > 1` work with MTP?** Unknown; the old gate was an assumption, never measured, and
both shipped seats run `total_slots: 1`. The gate is now empty so this can be benchmarked:
`-np 2 --spec-type draft-mtp --spec-draft-n-max 3`. Re-add to `SPEC_TYPES_BLOCKING_PARALLEL` only
on a measured engine failure. If it *does* work it is a significant throughput win and changes the
value of MTP substantially.

**Q2 — is `mtp_p_min` default `0` correct?** Factory default is `0` (accept every draft) and `0.5`
is not in the `values` list, while upstream measured 1.55× at acceptance 0.640 with `p-min 0.5`.
Owner's call in-app; flagged because a bad default makes a fair llama-vs-STRATA comparison lie.

**Q3 — engine build.** Upstream MTP for Qwen3.8-Flash-Next is
[llama.cpp #29761](https://github.com/ggml-org/llama.cpp/pull/29761), merged 2026-10-01, using the
same `--spec-type draft-mtp` / `--spec-draft-n-max` flags the app already emits. Two adjacent PRs
matter for any benchmark: [#28068](https://github.com/ggml-org/llama.cpp/pull/28068) (GDN
`max`→`rsqrt`) cost ~4% prefill and
[#29393](https://github.com/ggml-org/llama.cpp/pull/29393) (CUDA RMS_NORM+SCALE fusion) recovers
it. A build with the first but not the second will lose on prefill for reasons unrelated to MTP.

**Q4 — does `mtp_embedded` remain a distinct role, or become `target + capability`?** Under the
rule table, "baked MTP" is a property of a target, not a draft role. Cleaner as
`SpecCapability`, but it is currently load-bearing in `isExternalDraftOnly` and the catalog filter.

**Q5 — DSpark's real distinction.** Today DSpark is a CLI type sharing DFlash's knobs and group,
identified by a path substring, and validated by the draft *path* containing "dspark". With
`markov_w1.weight` available it can be a header fact instead.
