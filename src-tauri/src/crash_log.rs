//! Windows native exception logger — captures STATUS_* codes that bypass Rust's panic hook.

/// Silence the Windows “has stopped working” dialog for this process **and every
/// child it spawns**.
///
/// Helper binaries legitimately crash on GGUFs their build cannot load:
/// `llama-fit-params` exits `0xC0000409` on a draft tensor or an unimplemented
/// arch, a dozen times during a library scan. Each crash raised a modal WER box
/// that stole focus and stacked up — from the UI it looked like the app itself
/// was dying. The error mode is inherited at `CreateProcess` unless the child is
/// created with `CREATE_DEFAULT_ERROR_MODE`, so one process-wide setting covers
/// the whole spawn surface.
///
/// Evidence is not lost: the vectored exception logger below and the session log
/// still record every native exception in this process, and child failures keep
/// arriving in the fit-scan warnings.
#[cfg(windows)]
pub fn silence_crash_dialogs() {
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
    };
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

#[cfg(not(windows))]
pub fn silence_crash_dialogs() {}

#[cfg(windows)]
mod imp {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::System::Diagnostics::Debug::{
        AddVectoredExceptionHandler, EXCEPTION_POINTERS,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;
    use windows_sys::Win32::System::Memory::{VirtualQuery, MEMORY_BASIC_INFORMATION};

    static INSTALLED: AtomicBool = AtomicBool::new(false);

    fn append_crash_line(line: &str) {
        crate::session_log::append_crash_line(line);
        let path = std::env::temp_dir().join("blackwell-crash.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }

    fn module_label_for_addr(addr: usize) -> String {
        let mut mbi = MEMORY_BASIC_INFORMATION::default();
        // SAFETY: addr is the faulting IP; mbi receives query results.
        let written = unsafe {
            VirtualQuery(
                addr as *const core::ffi::c_void,
                &mut mbi,
                std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if written == 0 || mbi.AllocationBase.is_null() {
            return "module=unknown".to_string();
        }

        let base = mbi.AllocationBase as usize;
        let offset = addr.saturating_sub(base);
        let mut path_buf = [0u16; 512];
        // SAFETY: AllocationBase is a valid module base from VirtualQuery.
        let len = unsafe {
            GetModuleFileNameW(
                mbi.AllocationBase,
                path_buf.as_mut_ptr(),
                path_buf.len() as u32,
            )
        };
        if len == 0 {
            return format!("module_base=0x{base:X} offset=0x{offset:X}");
        }

        let path = String::from_utf16_lossy(&path_buf[..len as usize]);
        let file = path.rsplit(['\\', '/']).next().unwrap_or(&path);
        format!("module={file} base=0x{base:X} offset=0x{offset:X}")
    }

    unsafe extern "system" fn vectored_handler(info: *mut EXCEPTION_POINTERS) -> i32 {
        if info.is_null() {
            return 0;
        }
        let record = (*info).ExceptionRecord;
        if record.is_null() {
            return 0;
        }

        let code = (*record).ExceptionCode as u32;
        // Benign Windows noise — not process-fatal:
        // - 0x40080201 / 0x406D1388: instrumentation + MSVC thread naming
        // - 0xE06D7363: MSVC C++ exception ("msc") — WebView/COM throw/catch noise (tens of thousands)
        if matches!(code, 0x4008_0201 | 0x406D_1388 | 0xE06D_7363) {
            return 0;
        }

        let addr = (*record).ExceptionAddress as usize;
        let thread_id = windows_sys::Win32::System::Threading::GetCurrentThreadId();
        let module = module_label_for_addr(addr);

        append_crash_line(&format!(
            "[EXCEPTION] code=0x{code:08X} addr=0x{addr:X} thread={thread_id} {module}"
        ));

        0 // EXCEPTION_CONTINUE_SEARCH — preserve normal crash behavior
    }

    pub fn install() {
        if INSTALLED.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe {
            AddVectoredExceptionHandler(1, Some(vectored_handler));
        }
    }
}

#[cfg(windows)]
pub fn install_native_exception_logger() {
    imp::install();
}

#[cfg(not(windows))]
pub fn install_native_exception_logger() {}