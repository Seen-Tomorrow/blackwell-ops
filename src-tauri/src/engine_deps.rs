//! Name the dependent DLL that killed an engine in the Windows loader.
//!
//! STATUS_DLL_NOT_FOUND (0xC0000135) stops the process before `main()`, so the engine writes no
//! log line and the exit code is the only evidence. Walking the PE import table of the binary -
//! and of the engine-local DLLs it pulls in - turns that into "cublas64_13.dll missing", which is
//! the difference between a support round trip and a fix.
//!
//! Only the loader's own search order is modelled: the directory holding the exe, the extra dirs
//! the launcher puts on PATH (portable CUDA bins, CRT), System32, the Windows dir and PATH. A DLL
//! found in System32 is treated as present and is never parsed - recursing into the system
//! library graph would be slow and tells us nothing.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Bound on files inspected per call. The engine graph is ~20 DLLs; this only exists so a corrupt
/// import table cannot make a diagnostic loop.
const MAX_FILES: usize = 64;

struct Section {
    va: u32,
    size: u32,
    raw: u32,
}

fn read_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

fn read_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

fn rva_to_off(sections: &[Section], rva: u32) -> Option<u32> {
    sections
        .iter()
        .find(|s| rva >= s.va && rva < s.va.saturating_add(s.size))
        .map(|s| s.raw + (rva - s.va))
}

/// Import DLL names of one PE file, in table order. `None` when the file is not a readable PE.
fn pe_imports(path: &Path) -> Option<Vec<String>> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut dos = [0u8; 0x40];
    f.read_exact(&mut dos).ok()?;
    if &dos[0..2] != b"MZ" {
        return None;
    }
    let pe_off = read_u32(&dos, 0x3c)? as u64;
    f.seek(SeekFrom::Start(pe_off)).ok()?;

    let mut coff = [0u8; 24];
    f.read_exact(&mut coff).ok()?;
    if &coff[0..4] != b"PE\0\0" {
        return None;
    }
    let n_sections = read_u16(&coff, 6)? as usize;
    let opt_size = read_u16(&coff, 20)? as usize;

    let mut opt = vec![0u8; opt_size];
    f.read_exact(&mut opt).ok()?;
    // Data-directory offset differs between PE32 and PE32+.
    let (n_dirs_off, dirs_off) = match read_u16(&opt, 0)? {
        0x20b => (108usize, 112usize),
        0x10b => (92usize, 96usize),
        _ => return None,
    };
    if opt.len() < dirs_off + 16 || read_u32(&opt, n_dirs_off)? < 2 {
        return None;
    }
    let import_rva = read_u32(&opt, dirs_off + 8)?;
    if import_rva == 0 {
        return Some(Vec::new());
    }

    let mut sections = Vec::with_capacity(n_sections);
    let mut raw = [0u8; 40];
    for _ in 0..n_sections {
        f.read_exact(&mut raw).ok()?;
        let size = read_u32(&raw, 8)?;
        sections.push(Section {
            va: read_u32(&raw, 12)?,
            size: size.max(1),
            raw: read_u32(&raw, 20)?,
        });
    }

    let mut desc_off = rva_to_off(&sections, import_rva)? as u64;
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    loop {
        f.seek(SeekFrom::Start(desc_off)).ok()?;
        let mut desc = [0u8; 20];
        if f.read_exact(&mut desc).is_err() {
            break;
        }
        let name_rva = read_u32(&desc, 12)?;
        if name_rva == 0 {
            break;
        }
        let Some(name_off) = rva_to_off(&sections, name_rva) else {
            break;
        };
        f.seek(SeekFrom::Start(name_off as u64)).ok()?;
        let mut bytes = Vec::new();
        loop {
            let mut b = [0u8; 1];
            if f.read_exact(&mut b).is_err() || b[0] == 0 || bytes.len() >= 255 {
                break;
            }
            bytes.push(b[0]);
        }
        if bytes.is_empty() {
            break;
        }
        let name = String::from_utf8_lossy(&bytes).to_string();
        if seen.insert(name.to_ascii_lowercase()) {
            names.push(name);
        }
        desc_off += 20;
        if names.len() > 512 {
            break;
        }
    }
    Some(names)
}

/// API-set and extension-set names resolve through the loader's own tables, not as files on disk;
/// a file check would report them as missing on every binary ever built.
fn is_loader_alias(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("api-ms-win-") || lower.starts_with("ext-ms-")
}

fn find_in(dir: &Path, name: &str) -> Option<PathBuf> {
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    // The engine dir comes from a .7z with mixed-case names; scan so a case difference cannot
    // turn a present DLL into a reported miss.
    let want = name.to_ascii_lowercase();
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().to_ascii_lowercase() == want)
        .map(|e| e.path())
}

fn search_dirs(exe: &Path, extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = exe.parent() {
        dirs.push(parent.to_path_buf());
    }
    dirs.extend(extra.iter().cloned());
    if let Ok(root) = std::env::var("SystemRoot") {
        dirs.push(PathBuf::from(&root).join("System32"));
        dirs.push(PathBuf::from(&root));
    }
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(
            path.split(';')
                .map(str::trim)
                .filter(|e| !e.is_empty())
                // The launcher scrubs foreign CUDA from the child PATH and binds the portable
                // runtime instead, so a system NVIDIA toolkit must not make a missing portable
                // runtime look resolved - that false negative is exactly this diagnostic's job.
                .filter(|e| !crate::foundry_toolchain::path_entry_is_foreign_cuda(e))
                .map(PathBuf::from),
        );
    }
    dirs
}

/// Dependent DLLs that cannot be resolved for `exe`, following imports through the DLLs that live
/// in the engine dir or in `extra` (a missing second-level dep kills the load just the same).
pub fn missing_dependencies(exe: &Path, extra: &[PathBuf]) -> Vec<String> {
    let dirs = search_dirs(exe, extra);

    let mut missing = std::collections::BTreeSet::new();
    let mut queue = vec![exe.to_path_buf()];
    let mut inspected: HashSet<PathBuf> = HashSet::new();

    while let Some(file) = queue.pop() {
        if inspected.len() >= MAX_FILES || !inspected.insert(file.clone()) {
            continue;
        }
        let Some(imports) = pe_imports(&file) else {
            continue;
        };
        for name in imports {
            if is_loader_alias(&name) {
                continue;
            }
            match dirs.iter().find_map(|d| find_in(d, &name)) {
                None => {
                    missing.insert(name);
                }
                Some(found) => {
                    // Recurse into our own tree only; system DLLs are assumed self-contained.
                    let local = exe
                        .parent()
                        .map(|d| found.starts_with(d))
                        .unwrap_or(false)
                        || extra.iter().any(|d| found.starts_with(d));
                    if local {
                        queue.push(found);
                    }
                }
            }
        }
    }
    missing.into_iter().collect()
}

/// Same as [`missing_dependencies`], but resolves the CUDA + CRT dirs from the binary profile -
/// the exact dirs `apply_portable_cuda_to_command` puts on the child PATH.
pub fn missing_dependencies_for_profile(exe: &Path, binary_profile: &str) -> Vec<String> {
    let mut extra = Vec::new();
    if let Some(version) = crate::foundry_toolchain::cuda_version_for_binary_profile(binary_profile)
    {
        let root = crate::foundry_toolchain::toolchain_dir()
            .join("cuda")
            .join(format!("v{version}"));
        for sub in ["bin/x64", "bin"] {
            let dir = root.join(sub);
            if dir.is_dir() {
                extra.push(dir);
            }
        }
    }
    if let Some(crt) = crate::foundry_toolchain::msvc_crt_dir_for_profile(binary_profile) {
        extra.push(crt);
    }
    missing_dependencies(exe, &extra)
}

/// Human sentence appended to a launch failure. Says "none found" rather than nothing, because an
/// empty result with 0xC0000135 still means the loader saw something this static check does not.
pub fn describe_missing_dlls(exe: &Path, binary_profile: &str) -> String {
    let missing = missing_dependencies_for_profile(exe, binary_profile);
    if missing.is_empty() {
        format!(
            "static import check: no missing DLL for {} (profile {binary_profile}); the loader may resolve differently - compare the child PATH with the engine dir",
            exe.display()
        )
    } else {
        format!(
            "missing dependent DLL(s) for {}: {}",
            exe.display(),
            missing.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loader_aliases_are_not_reported_missing() {
        assert!(is_loader_alias("api-ms-win-crt-stdio-l1-1-0.dll"));
        assert!(is_loader_alias("ext-ms-win-something.dll"));
        assert!(!is_loader_alias("cublas64_13.dll"));
        assert!(!is_loader_alias("msvcp140.dll"));
    }

    /// The test binary is a real PE, so parsing it exercises the header/section/import walk
    /// without a fixture. Every Windows binary imports at least KERNEL32.
    #[cfg(windows)]
    #[test]
    fn parses_own_import_table() {
        let exe = std::env::current_exe().expect("current_exe");
        let imports = pe_imports(&exe).expect("PE parse");
        assert!(!imports.is_empty(), "no imports parsed from {}", exe.display());
        assert!(
            imports.iter().any(|n| n.eq_ignore_ascii_case("kernel32.dll")),
            "KERNEL32.dll not among imports: {imports:?}"
        );
    }

    #[test]
    fn non_pe_file_yields_nothing() {
        let dir = std::env::temp_dir().join("blackwell-ops-engine-deps-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not-a-pe.dll");
        std::fs::write(&path, b"definitely not a PE file").unwrap();
        assert!(pe_imports(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }
}
