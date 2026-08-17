//! CPU CCD topology + llama-server affinity injection.
//!
//! On asymmetric X3D (two L3 domains, different sizes):
//! - larger L3 = V-Cache CCD
//! - smaller L3 = compute / frequency CCD
//!
//! Default launch policy (measured best on 9950X3D GPU decode): pin to the
//! **V-Cache** CCD, high-half cores with SMT (e.g. mask `ff00` = LP 8–15),
//! `--cpu-strict 1`, modest `-t` (≤8). Also applies **process** affinity via
//! `SetProcessAffinityMask` — llama's `--cpu-mask` only pins ggml worker
//! threads; Task Manager / PPM still see the unrestricted process mask otherwise.

use std::sync::OnceLock;

use crate::types::EngineConfig;

/// Soft cap for auto-injected generation/batch threads on a pinned CCD.
pub const DEFAULT_AFFINITY_THREADS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AffinityMode {
    /// V-Cache CCD when asymmetric L3 exists; otherwise leave affinity alone.
    Auto,
    Off,
    Compute,
    Vcache,
}

impl AffinityMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "0" | "false" | "none" => Self::Off,
            "compute" | "freq" | "frequency" => Self::Compute,
            "vcache" | "cache" | "3d" | "x3d" => Self::Vcache,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CcdInfo {
    /// Logical-processor mask (group 0) covering this L3 domain.
    pub lp_mask: u64,
    pub l3_bytes: u64,
    /// One LP per physical core (lowest bit of each SMT pair), ascending.
    pub physical_lps: Vec<u32>,
}

impl CcdInfo {
    pub fn physical_mask(&self) -> u64 {
        self.physical_lps
            .iter()
            .fold(0u64, |acc, &lp| acc | (1u64 << lp))
    }

    pub fn l3_mib(&self) -> u64 {
        self.l3_bytes / (1024 * 1024)
    }
}

#[derive(Debug, Clone)]
pub struct CpuTopology {
    pub ccds: Vec<CcdInfo>,
    /// Index of smaller L3 when exactly two unequal L3 domains exist.
    pub compute_idx: Option<usize>,
    /// Index of larger L3 when exactly two unequal L3 domains exist.
    pub vcache_idx: Option<usize>,
}

impl CpuTopology {
    pub fn is_asymmetric_x3d(&self) -> bool {
        self.compute_idx.is_some() && self.vcache_idx.is_some()
    }

    pub fn ccd(&self, idx: usize) -> Option<&CcdInfo> {
        self.ccds.get(idx)
    }
}

#[derive(Debug, Clone)]
pub struct AffinityPlan {
    pub mode: AffinityMode,
    pub label: String,
    /// All logical processors in the mask (includes SMT siblings).
    pub lps: Vec<u32>,
    pub cpu_mask: u64,
    pub cpu_mask_hex: String,
    pub threads: usize,
    pub l3_mib: u64,
}

static TOPOLOGY: OnceLock<CpuTopology> = OnceLock::new();

/// Cached topology (Windows GLPIE). Empty / single-CCD on failure or non-Windows.
pub fn topology() -> &'static CpuTopology {
    TOPOLOGY.get_or_init(detect_topology)
}

pub fn affinity_mode_from_config(config: &EngineConfig) -> AffinityMode {
    // Prefer explicit launch override; fall back to auto.
    if let Some(v) = config
        .extra_params
        .get("__cpu_affinity")
        .and_then(|v| v.as_str())
    {
        return AffinityMode::parse(v);
    }
    if let Some(v) = config.get_param_str("__cpu_affinity") {
        return AffinityMode::parse(&v);
    }
    AffinityMode::Auto
}

/// Build a pin plan, or `None` when affinity should stay untouched.
pub fn plan_affinity(mode: AffinityMode, thread_hint: Option<usize>) -> Option<AffinityPlan> {
    plan_affinity_with(topology(), mode, thread_hint)
}

/// Testable planner over an explicit topology snapshot.
///
/// Mask policy (matches measured best `ff00` on 9950X3D):
/// - pick V-Cache (auto) or explicit CCD
/// - take physical cores from the **high end** of that CCD (skip LP0 / low half)
/// - include **both SMT siblings** per core
/// - target ≤ [`DEFAULT_AFFINITY_THREADS`] logical processors
pub fn plan_affinity_with(
    topo: &CpuTopology,
    mode: AffinityMode,
    thread_hint: Option<usize>,
) -> Option<AffinityPlan> {
    let idx = match mode {
        AffinityMode::Off => return None,
        AffinityMode::Auto => {
            if !topo.is_asymmetric_x3d() {
                return None;
            }
            topo.vcache_idx?
        }
        AffinityMode::Compute => topo.compute_idx?,
        AffinityMode::Vcache => topo.vcache_idx?,
    };
    let ccd = topo.ccd(idx)?;
    if ccd.physical_lps.is_empty() || ccd.lp_mask == 0 {
        return None;
    }

    let target_lps = match thread_hint {
        Some(n) => n.clamp(1, DEFAULT_AFFINITY_THREADS),
        None => DEFAULT_AFFINITY_THREADS,
    };
    // Each physical core contributes 2 LPs when SMT sibling is in the CCD mask.
    let lps_per_core = if smt_sibling(ccd.physical_lps[0], ccd.lp_mask).is_some() {
        2usize
    } else {
        1usize
    };
    let max_cores = ccd.physical_lps.len();
    let want_cores = ((target_lps + lps_per_core - 1) / lps_per_core)
        .clamp(1, max_cores)
        .min(DEFAULT_AFFINITY_THREADS);

    // High half: last `want_cores` physical cores on this CCD.
    let start = max_cores.saturating_sub(want_cores);
    let mut lps = Vec::with_capacity(want_cores * lps_per_core);
    let mut mask = 0u64;
    for &primary in &ccd.physical_lps[start..] {
        mask |= 1u64 << primary;
        lps.push(primary);
        if let Some(sib) = smt_sibling(primary, ccd.lp_mask) {
            mask |= 1u64 << sib;
            lps.push(sib);
        }
    }
    lps.sort_unstable();
    lps.dedup();
    if mask == 0 || lps.is_empty() {
        return None;
    }

    let threads = lps.len().min(DEFAULT_AFFINITY_THREADS).max(1);
    let label = match mode {
        AffinityMode::Vcache => "vcache",
        AffinityMode::Compute => "compute",
        AffinityMode::Auto => "vcache(auto)",
        AffinityMode::Off => "off",
    };

    Some(AffinityPlan {
        mode,
        label: label.into(),
        lps,
        cpu_mask: mask,
        cpu_mask_hex: format!("{mask:x}"),
        threads,
        l3_mib: ccd.l3_mib(),
    })
}

fn smt_sibling(primary: u32, ccd_mask: u64) -> Option<u32> {
    let sib = primary.checked_add(1)?;
    if sib >= 64 {
        return None;
    }
    if ccd_mask & (1u64 << sib) != 0 {
        Some(sib)
    } else {
        None
    }
}

/// Inject `--cpu-mask` / `--cpu-strict` / capped `--threads` when safe.
/// Returns the plan so the spawn path can also apply OS process affinity.
pub fn apply_to_launch_args(
    args: &mut Vec<String>,
    config: &EngineConfig,
) -> Option<AffinityPlan> {
    if user_owns_cpu_affinity(args) {
        log::debug!("[cpu-affinity] skip inject — user already set cpu-mask/range/strict");
        // Still return a plan from the user mask so process affinity can apply.
        return plan_from_existing_args(args);
    }

    let mode = affinity_mode_from_config(config);
    if mode == AffinityMode::Off {
        return None;
    }

    let existing_threads = read_thread_count(args, &["-t", "--threads"]);
    let existing_batch = read_thread_count(args, &["-tb", "--threads-batch"]);

    let plan = plan_affinity(mode, existing_threads)?;

    remove_flag_pairs(args, &["-t", "--threads"]);
    args.push("--threads".into());
    args.push(plan.threads.to_string());

    let batch_n = existing_batch
        .map(|n| n.clamp(1, plan.threads))
        .unwrap_or(plan.threads);
    remove_flag_pairs(args, &["-tb", "--threads-batch"]);
    args.push("--threads-batch".into());
    args.push(batch_n.to_string());

    args.push("--cpu-mask".into());
    args.push(plan.cpu_mask_hex.clone());
    args.push("--cpu-strict".into());
    args.push("1".into());

    let lps = plan
        .lps
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");
    log::info!(
        "[cpu-affinity] {} L3={}MiB mask=0x{} strict=1 threads={} batch={} lps=[{}]",
        plan.label,
        plan.l3_mib,
        plan.cpu_mask_hex,
        plan.threads,
        batch_n,
        lps
    );
    Some(plan)
}

/// Parse `--cpu-mask` hex from launch args (if present).
pub fn cpu_mask_from_args(args: &[String]) -> Option<u64> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--cpu-mask" || args[i] == "-C" {
            let hex = args.get(i + 1)?;
            return parse_hex_mask(hex);
        }
        i += 1;
    }
    None
}

fn plan_from_existing_args(args: &[String]) -> Option<AffinityPlan> {
    let mask = cpu_mask_from_args(args)?;
    let mut lps = Vec::new();
    for b in 0..64u32 {
        if mask & (1u64 << b) != 0 {
            lps.push(b);
        }
    }
    if lps.is_empty() {
        return None;
    }
    let threads = read_thread_count(args, &["-t", "--threads"]).unwrap_or(lps.len());
    Some(AffinityPlan {
        mode: AffinityMode::Auto,
        label: "user-mask".into(),
        lps,
        cpu_mask: mask,
        cpu_mask_hex: format!("{mask:x}"),
        threads: threads.max(1),
        l3_mib: 0,
    })
}

fn parse_hex_mask(raw: &str) -> Option<u64> {
    let s = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    u64::from_str_radix(s, 16).ok().filter(|m| *m != 0)
}

/// Pin the whole process (all threads) — what Process Lasso / Task Manager show.
/// Non-fatal: logs and returns on failure.
pub fn apply_process_affinity(pid: u32, mask: u64) {
    if pid == 0 || mask == 0 {
        return;
    }
    #[cfg(windows)]
    {
        match set_process_affinity_mask(pid, mask) {
            Ok(()) => log::info!(
                "[cpu-affinity] SetProcessAffinityMask pid={pid} mask=0x{mask:x}"
            ),
            Err(e) => log::warn!(
                "[cpu-affinity] SetProcessAffinityMask pid={pid} mask=0x{mask:x} failed: {e}"
            ),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, mask);
    }
}

/// Convenience: read mask from launch argv and apply process affinity.
pub fn apply_process_affinity_from_args(pid: u32, args: &[String]) {
    if let Some(mask) = cpu_mask_from_args(args) {
        apply_process_affinity(pid, mask);
    }
}

#[cfg(windows)]
fn set_process_affinity_mask(pid: u32, mask: u64) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, FALSE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
    };

    // PROCESS_SET_INFORMATION = 0x0200 — required by SetProcessAffinityMask.
    const PROCESS_SET_INFORMATION: u32 = 0x0200;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetProcessAffinityMask(h_process: isize, dw_process_affinity_mask: usize) -> i32;
    }

    let access = PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA;
    let handle = unsafe { OpenProcess(access, FALSE, pid) };
    // OpenProcess failure is NULL, not INVALID_HANDLE_VALUE.
    if handle.is_null() {
        let err = unsafe { GetLastError() };
        return Err(format!("OpenProcess failed ({err})"));
    }
    let ok = unsafe { SetProcessAffinityMask(handle as isize, mask as usize) };
    let err = unsafe { GetLastError() };
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        return Err(format!("SetProcessAffinityMask failed ({err})"));
    }
    Ok(())
}

fn user_owns_cpu_affinity(args: &[String]) -> bool {
    const FLAGS: &[&str] = &[
        "-C",
        "--cpu-mask",
        "-Cr",
        "--cpu-range",
        "--cpu-strict",
        "-Cb",
        "--cpu-mask-batch",
        "-Crb",
        "--cpu-range-batch",
        "--cpu-strict-batch",
    ];
    args.iter().any(|a| FLAGS.iter().any(|f| a == f))
}

fn read_thread_count(args: &[String], flags: &[&str]) -> Option<usize> {
    let mut i = 0;
    while i < args.len() {
        if flags.iter().any(|f| args[i] == *f) {
            if let Some(v) = args.get(i + 1) {
                if let Ok(n) = v.parse::<usize>() {
                    return Some(n);
                }
            }
        }
        i += 1;
    }
    None
}

fn remove_flag_pairs(args: &mut Vec<String>, flags: &[&str]) {
    let mut i = 0;
    while i < args.len() {
        if flags.iter().any(|f| args[i] == *f) {
            args.remove(i);
            if i < args.len() && !args[i].starts_with('-') {
                args.remove(i);
            }
            continue;
        }
        i += 1;
    }
}

fn detect_topology() -> CpuTopology {
    #[cfg(windows)]
    {
        match detect_topology_windows() {
            Ok(t) => {
                log_topology(&t);
                t
            }
            Err(e) => {
                log::warn!("[cpu-affinity] topology detect failed: {e}");
                CpuTopology {
                    ccds: Vec::new(),
                    compute_idx: None,
                    vcache_idx: None,
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        CpuTopology {
            ccds: Vec::new(),
            compute_idx: None,
            vcache_idx: None,
        }
    }
}

fn log_topology(t: &CpuTopology) {
    if t.ccds.is_empty() {
        log::info!("[cpu-affinity] topology: no L3 domains");
        return;
    }
    for (i, c) in t.ccds.iter().enumerate() {
        let tag = if Some(i) == t.compute_idx {
            " compute"
        } else if Some(i) == t.vcache_idx {
            " vcache"
        } else {
            ""
        };
        log::info!(
            "[cpu-affinity] CCD{i}{tag} L3={}MiB lps=0x{:x} phys={} [{:?}]",
            c.l3_mib(),
            c.lp_mask,
            c.physical_lps.len(),
            c.physical_lps
        );
    }
}

/// Build topology from L3 masks + physical-core LP lists (testable).
pub fn topology_from_l3_and_cores(l3: &[(u64, u64)], core_masks: &[u64]) -> CpuTopology {
    let mut ccds: Vec<CcdInfo> = l3
        .iter()
        .copied()
        .filter(|(mask, size)| *mask != 0 && *size > 0)
        .map(|(lp_mask, l3_bytes)| {
            let physical_lps = physical_lps_for_mask(lp_mask, core_masks);
            CcdInfo {
                lp_mask,
                l3_bytes,
                physical_lps,
            }
        })
        .collect();
    ccds.sort_by(|a, b| a.lp_mask.cmp(&b.lp_mask));

    let (compute_idx, vcache_idx) = classify_asymmetric(&ccds);
    CpuTopology {
        ccds,
        compute_idx,
        vcache_idx,
    }
}

fn classify_asymmetric(ccds: &[CcdInfo]) -> (Option<usize>, Option<usize>) {
    if ccds.len() != 2 {
        return (None, None);
    }
    let a = ccds[0].l3_bytes;
    let b = ccds[1].l3_bytes;
    if a == b || a == 0 || b == 0 {
        return (None, None);
    }
    if a < b {
        (Some(0), Some(1))
    } else {
        (Some(1), Some(0))
    }
}

fn physical_lps_for_mask(ccd_mask: u64, core_masks: &[u64]) -> Vec<u32> {
    let mut lps = Vec::new();
    for &core in core_masks {
        let overlap = core & ccd_mask;
        if overlap == 0 {
            continue;
        }
        // Primary (lowest) LP of the SMT pair.
        let lp = overlap.trailing_zeros();
        if lp < 64 {
            lps.push(lp);
        }
    }
    if lps.is_empty() {
        // Fallback: every other bit in the CCD mask (assume SMT pairs).
        let mut bit = 0u32;
        let mut m = ccd_mask;
        while m != 0 {
            if m & 1 != 0 {
                lps.push(bit);
                // skip sibling if present
                m >>= 1;
                bit += 1;
                if m & 1 != 0 {
                    m >>= 1;
                    bit += 1;
                }
                continue;
            }
            m >>= 1;
            bit += 1;
        }
    }
    lps.sort_unstable();
    lps.dedup();
    lps
}

#[cfg(windows)]
fn detect_topology_windows() -> Result<CpuTopology, String> {
    use std::mem;
    use std::ptr;

    #[repr(C)]
    struct Header {
        relationship: u32,
        size: u32,
    }

    const RELATION_PROCESSOR_CORE: u32 = 0;
    const RELATION_CACHE: u32 = 2;
    const RELATION_ALL: u32 = 0xffff;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalProcessorInformationEx(
            relationship_type: u32,
            buffer: *mut u8,
            return_length: *mut u32,
        ) -> i32;
        fn GetLastError() -> u32;
    }

    unsafe {
        let mut len: u32 = 0;
        let _ = GetLogicalProcessorInformationEx(RELATION_ALL, ptr::null_mut(), &mut len);
        if len == 0 {
            return Err(format!(
                "GetLogicalProcessorInformationEx size query failed ({})",
                GetLastError()
            ));
        }
        let mut buf = vec![0u8; len as usize];
        let ok = GetLogicalProcessorInformationEx(RELATION_ALL, buf.as_mut_ptr(), &mut len);
        if ok == 0 {
            return Err(format!(
                "GetLogicalProcessorInformationEx failed ({})",
                GetLastError()
            ));
        }

        let mut l3: Vec<(u64, u64)> = Vec::new();
        let mut core_masks: Vec<u64> = Vec::new();

        let mut offset = 0usize;
        let end = len as usize;
        while offset + mem::size_of::<Header>() <= end {
            let hdr = &*(buf.as_ptr().add(offset) as *const Header);
            let size = hdr.size as usize;
            if size < mem::size_of::<Header>() || offset + size > end {
                break;
            }
            let body = offset + mem::size_of::<Header>();

            match hdr.relationship {
                RELATION_PROCESSOR_CORE => {
                    // PROCESSOR_RELATIONSHIP: Flags@0 Eff@1 Reserved[20] GroupCount@22
                    // GROUP_AFFINITY @24: Mask u64
                    if body + 32 <= offset + size {
                        let group_count =
                            u16::from_le_bytes([buf[body + 22], buf[body + 23]]);
                        if group_count >= 1 {
                            let mask = u64::from_le_bytes(
                                buf[body + 24..body + 32].try_into().unwrap(),
                            );
                            if mask != 0 {
                                core_masks.push(mask);
                            }
                        }
                    }
                }
                RELATION_CACHE => {
                    // CACHE_RELATIONSHIP:
                    // Level@0 Assoc@1 Line@2 Size@4 Type@8 Reserved[18] GroupCount@30 GA@32
                    if body + 40 <= offset + size {
                        let level = buf[body];
                        if level == 3 {
                            let cache_size = u32::from_le_bytes(
                                buf[body + 4..body + 8].try_into().unwrap(),
                            ) as u64;
                            let group_count =
                                u16::from_le_bytes([buf[body + 30], buf[body + 31]]);
                            if group_count >= 1 && cache_size > 0 {
                                let mask = u64::from_le_bytes(
                                    buf[body + 32..body + 40].try_into().unwrap(),
                                );
                                if mask != 0 {
                                    // Merge duplicate L3 entries with same mask.
                                    if let Some(slot) = l3.iter_mut().find(|(m, _)| *m == mask) {
                                        slot.1 = slot.1.max(cache_size);
                                    } else {
                                        l3.push((mask, cache_size));
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            offset += size;
        }

        Ok(topology_from_l3_and_cores(&l3, &core_masks))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn x3d_topo() -> CpuTopology {
        // 9950X3D-shaped: LP0-15 vcache 96MiB, LP16-31 compute 32MiB, SMT pairs.
        let mut cores = Vec::new();
        for i in 0..16u32 {
            cores.push(0b11u64 << (i * 2));
        }
        topology_from_l3_and_cores(
            &[
                (0x0000_ffff, 96 * 1024 * 1024),
                (0xffff_0000, 32 * 1024 * 1024),
            ],
            &cores,
        )
    }

    #[test]
    fn classifies_compute_and_vcache() {
        let t = x3d_topo();
        assert!(t.is_asymmetric_x3d());
        let c = t.ccd(t.compute_idx.unwrap()).unwrap();
        let v = t.ccd(t.vcache_idx.unwrap()).unwrap();
        assert_eq!(c.l3_mib(), 32);
        assert_eq!(v.l3_mib(), 96);
        assert_eq!(c.physical_lps, vec![16, 18, 20, 22, 24, 26, 28, 30]);
        assert_eq!(v.physical_lps, vec![0, 2, 4, 6, 8, 10, 12, 14]);
    }

    #[test]
    fn auto_plan_is_vcache_high_half_smt_ff00() {
        let t = x3d_topo();
        let plan = plan_affinity_with(&t, AffinityMode::Auto, None).expect("plan");
        assert_eq!(plan.threads, 8);
        assert_eq!(plan.cpu_mask, 0xff00);
        assert_eq!(plan.cpu_mask_hex, "ff00");
        assert_eq!(plan.lps, vec![8, 9, 10, 11, 12, 13, 14, 15]);
        assert_eq!(plan.l3_mib, 96);
        assert!(plan.label.contains("vcache"));
    }

    #[test]
    fn low_thread_hint_high_half_smt() {
        let t = x3d_topo();
        let plan = plan_affinity_with(&t, AffinityMode::Auto, Some(4)).expect("plan");
        assert_eq!(plan.threads, 4);
        assert_eq!(plan.cpu_mask_hex, "f000"); // LPs 12-15
        assert_eq!(plan.lps, vec![12, 13, 14, 15]);
    }

    #[test]
    fn high_thread_hint_capped_ff00() {
        let t = x3d_topo();
        let plan = plan_affinity_with(&t, AffinityMode::Auto, Some(32)).expect("plan");
        assert_eq!(plan.threads, 8);
        assert_eq!(plan.cpu_mask_hex, "ff00");
    }

    #[test]
    fn compute_mode_high_half_of_freq_ccd() {
        let t = x3d_topo();
        let plan = plan_affinity_with(&t, AffinityMode::Compute, None).expect("plan");
        assert_eq!(plan.cpu_mask_hex, "ff000000"); // LPs 24-31
        assert_eq!(plan.l3_mib, 32);
    }

    #[test]
    fn symmetric_l3_not_asymmetric() {
        let cores = (0..8u32).map(|i| 0b11u64 << (i * 2)).collect::<Vec<_>>();
        let t = topology_from_l3_and_cores(&[(0xff, 32 * 1024 * 1024)], &cores);
        assert!(!t.is_asymmetric_x3d());
        assert!(plan_affinity_with(&t, AffinityMode::Auto, None).is_none());
    }

    #[test]
    fn user_mask_skips_inject_but_parses() {
        let args = vec!["--cpu-mask".into(), "ff00".into(), "--threads".into(), "8".into()];
        assert!(user_owns_cpu_affinity(&args));
        assert_eq!(cpu_mask_from_args(&args), Some(0xff00));
    }

    #[test]
    fn mode_parse() {
        assert_eq!(AffinityMode::parse("AUTO"), AffinityMode::Auto);
        assert_eq!(AffinityMode::parse("off"), AffinityMode::Off);
        assert_eq!(AffinityMode::parse("compute"), AffinityMode::Compute);
        assert_eq!(AffinityMode::parse("vcache"), AffinityMode::Vcache);
    }

    #[test]
    fn mode_from_extra_params() {
        let mut extra = HashMap::new();
        extra.insert(
            "__cpu_affinity".into(),
            serde_json::Value::String("off".into()),
        );
        let cfg = EngineConfig {
            alias: String::new(),
            model_path: String::new(),
            port: 0,
            backend_type: String::new(),
            binary_profile: String::new(),
            extra_params: extra,
        };
        assert_eq!(affinity_mode_from_config(&cfg), AffinityMode::Off);
    }

    #[test]
    fn live_windows_topology_smoke() {
        let t = topology();
        if t.ccds.len() < 2 {
            return;
        }
        assert!(
            t.is_asymmetric_x3d(),
            "two L3 domains should classify compute/vcache: {:?}",
            t.ccds.iter().map(|c| c.l3_mib()).collect::<Vec<_>>()
        );
        let plan = plan_affinity(AffinityMode::Auto, None).expect("auto plan on X3D host");
        assert_eq!(plan.threads, plan.lps.len().min(DEFAULT_AFFINITY_THREADS));
        assert!(!plan.cpu_mask_hex.is_empty());
        // Measured best on this class: vcache high-half.
        assert!(plan.label.contains("vcache"), "auto should pick vcache: {}", plan.label);

        let mut args = vec![
            "-m".into(),
            "x.gguf".into(),
            "--threads".into(),
            "32".into(),
        ];
        let cfg = EngineConfig {
            alias: String::new(),
            model_path: String::new(),
            port: 0,
            backend_type: String::new(),
            binary_profile: String::new(),
            extra_params: HashMap::new(),
        };
        apply_to_launch_args(&mut args, &cfg);
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--cpu-mask" && w[1] == "ff00"),
            "expected mask ff00: {args:?}"
        );
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--cpu-strict" && w[1] == "1"),
            "expected cpu-strict 1: {args:?}"
        );
        assert!(
            args.windows(2).any(|w| w[0] == "--threads" && w[1] == "8"),
            "expected threads capped to 8: {args:?}"
        );
    }
}
