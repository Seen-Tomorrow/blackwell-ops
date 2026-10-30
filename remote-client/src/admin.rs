//! Owner / administrator gate for Local Power Mode.
//!
//! Local Pi keeps the full `read`, `powershell`, `edit`, `write` tool set, so it
//! is the owner's surface, not the family one (DECISIONS D-011/D-017). Home PCs
//! are single-user administrator machines, which makes membership of
//! `BUILTIN\Administrators` the boundary.
//!
//! Elevation is deliberately **not** required. UAC splits an administrator's
//! token: the group is still present but marked
//! `SE_GROUP_USE_FOR_DENY_ONLY`, so `CheckTokenMembership` answers "no" and an
//! elevation check would reject the usual double-clicked console. This walks
//! `TokenGroups` and matches the SID regardless of the attribute, which is what
//! "the owner account on this PC" means in practice.

/// `BUILTIN\Administrators` = S-1-5-32-544.
#[cfg(windows)]
unsafe fn is_builtin_administrators(sid: *const core::ffi::c_void) -> bool {
    if sid.is_null() {
        return false;
    }
    let bytes = sid.cast::<u8>();
    // SID layout: revision, sub-authority count, 6-byte identifier authority,
    // then `count` little-endian u32 sub-authorities.
    if *bytes != 1 {
        return false;
    }
    if *bytes.add(1) != 2 {
        return false;
    }
    let authority = std::slice::from_raw_parts(bytes.add(2), 6);
    if authority != [0, 0, 0, 0, 0, 5] {
        return false;
    }
    let read = |offset: usize| {
        let raw = std::slice::from_raw_parts(bytes.add(offset), 4);
        u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])
    };
    read(8) == 32 && read(12) == 544
}

#[cfg(windows)]
pub(crate) fn current_user_is_local_admin() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenGroups, TOKEN_GROUPS, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }

        // First call sizes the variable-length TOKEN_GROUPS buffer. The buffer is
        // allocated as `usize` words so the TOKEN_GROUPS cast stays aligned.
        let mut needed: u32 = 0;
        GetTokenInformation(token, TokenGroups, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            CloseHandle(token);
            return false;
        }
        let words = (needed as usize).div_ceil(std::mem::size_of::<usize>());
        let mut buffer = vec![0usize; words];
        let ok = GetTokenInformation(
            token,
            TokenGroups,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return false;
        }

        let groups = &*(buffer.as_ptr() as *const TOKEN_GROUPS);
        if groups.GroupCount == 0 {
            return false;
        }
        let entries =
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize);
        entries
            .iter()
            .any(|entry| is_builtin_administrators(entry.Sid.cast()))
    }
}

/// Non-Windows builds exist only for `cargo check` on the remote crates; the
/// shipped client is Windows. Do not block the owner there.
#[cfg(not(windows))]
pub(crate) fn current_user_is_local_admin() -> bool {
    true
}

#[cfg(all(test, windows))]
mod tests {
    use super::is_builtin_administrators;

    fn sid(sub_authorities: &[u32]) -> Vec<u8> {
        let mut bytes = vec![1, sub_authorities.len() as u8, 0, 0, 0, 0, 0, 5];
        for value in sub_authorities {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn builtin_administrators_sid_is_the_only_match() {
        let administrators = sid(&[32, 544]);
        let users = sid(&[32, 545]);
        let domain_admins = sid(&[21, 1, 2, 3]);
        let mut wrong_revision = administrators.clone();
        wrong_revision[0] = 2;
        let mut wrong_authority = administrators.clone();
        wrong_authority[6] = 4;

        unsafe {
            assert!(is_builtin_administrators(administrators.as_ptr().cast()));
            assert!(!is_builtin_administrators(users.as_ptr().cast()));
            assert!(!is_builtin_administrators(domain_admins.as_ptr().cast()));
            assert!(!is_builtin_administrators(wrong_revision.as_ptr().cast()));
            assert!(!is_builtin_administrators(wrong_authority.as_ptr().cast()));
            assert!(!is_builtin_administrators(std::ptr::null()));
        }
    }

    #[test]
    fn the_current_test_process_resolves_admin_state_without_panicking() {
        // The value depends on who runs the tests; the contract is that the
        // token walk completes and returns a bool.
        let _ = super::current_user_is_local_admin();
    }
}
