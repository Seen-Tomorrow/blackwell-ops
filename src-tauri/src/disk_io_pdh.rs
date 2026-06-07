//! Windows PDH disk I/O sampler — persistent query handle, no PowerShell spawn.

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::ptr;
#[cfg(windows)]
use std::thread;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

#[cfg(windows)]
fn to_wide_null(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn pdh_ok(status: u32) -> bool {
    status == 0
}

#[cfg(windows)]
fn counter_double(counter: PDH_HCOUNTER) -> f64 {
    // SAFETY: counter is a valid PDH handle from PdhAddEnglishCounterW on our query.
    unsafe {
        let mut fmt_type = 0u32;
        let mut value = std::mem::zeroed::<PDH_FMT_COUNTERVALUE>();
        let status = PdhGetFormattedCounterValue(
            counter,
            PDH_FMT_DOUBLE,
            &mut fmt_type,
            &mut value,
        );
        if status == PDH_CSTATUS_VALID_DATA || status == PDH_CSTATUS_NEW_DATA {
            value.Anonymous.doubleValue
        } else {
            0.0
        }
    }
}

/// Persistent PDH query for system-wide disk read/write (+ mmap fallback via page faults).
#[cfg(windows)]
pub struct PdhDiskSampler {
    query: PDH_HQUERY,
    read_counter: PDH_HCOUNTER,
    write_counter: PDH_HCOUNTER,
    pages_counter: PDH_HCOUNTER,
}

#[cfg(windows)]
impl PdhDiskSampler {
    pub fn new() -> Result<Self, String> {
        let mut query: PDH_HQUERY = ptr::null_mut();
        // SAFETY: query receives a valid out-pointer; null datasource = local machine.
        let status = unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) };
        if !pdh_ok(status) {
            return Err(format!("PdhOpenQueryW failed: {status}"));
        }

        let sampler = Self {
            query,
            read_counter: add_counter(query, r"\PhysicalDisk(_Total)\Disk Read Bytes/sec")?,
            write_counter: add_counter(query, r"\PhysicalDisk(_Total)\Disk Write Bytes/sec")?,
            pages_counter: add_counter(query, r"\Memory\Pages Input/sec")?,
        };

        // Warm-up — rate counters need a baseline sample before the first read.
        let _ = unsafe { PdhCollectQueryData(query) };
        thread::sleep(Duration::from_millis(100));
        let _ = unsafe { PdhCollectQueryData(query) };

        Ok(sampler)
    }

    pub fn sample(&mut self) -> Result<(f32, f32), String> {
        // SAFETY: self.query is an open PDH query handle.
        let status = unsafe { PdhCollectQueryData(self.query) };
        if !pdh_ok(status) {
            return Err(format!("PdhCollectQueryData failed: {status}"));
        }

        let mut read = counter_double(self.read_counter);
        let write = counter_double(self.write_counter);

        // mmap-heavy loads: physical disk counter can under-report; page-in rate is a better hero signal.
        if read < 1_048_576.0 {
            let pages = counter_double(self.pages_counter);
            read = read.max(pages * 4096.0);
        }

        Ok((read as f32, write as f32))
    }
}

#[cfg(windows)]
fn add_counter(query: PDH_HQUERY, path: &str) -> Result<PDH_HCOUNTER, String> {
    let path_w = to_wide_null(path);
    let mut counter: PDH_HCOUNTER = ptr::null_mut();
    // SAFETY: query is open; path_w is null-terminated UTF-16.
    let status = unsafe { PdhAddEnglishCounterW(query, path_w.as_ptr(), 0, &mut counter) };
    if !pdh_ok(status) {
        return Err(format!("PdhAddEnglishCounterW({path}) failed: {status}"));
    }
    Ok(counter)
}

#[cfg(windows)]
impl Drop for PdhDiskSampler {
    fn drop(&mut self) {
        // SAFETY: self.query is an open PDH query handle (or null if construction failed mid-way).
        if !self.query.is_null() {
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }
}