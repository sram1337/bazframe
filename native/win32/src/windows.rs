// Windows HANDLE/reparse techniques are adapted from @openclaw/fs-safe 0.7.2
// (Copyright (c) 2026 openclaw, MIT). See ../OPENCLAW-LICENSE.

use std::ffi::{OsStr, c_void};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};

use napi::Error;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION, GENERIC_READ, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN, FILE_ID_INFO, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
    FileAttributeTagInfo, FileBasicInfo, FileIdInfo, FileStandardInfo, GetDriveTypeW,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetFullPathNameW,
    GetVolumeInformationByHandleW, OPEN_EXISTING, QueryDosDeviceW, ReadFile, VOLUME_NAME_GUID,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

use crate::{
    NativeResult, StableReadData, WindowsObjectObservation, WindowsPathInspection,
    WindowsVolumeObservation, native_error,
};

const DRIVE_FIXED: u32 = 3;
const FILE_PERSISTENT_ACLS: u32 = 0x0000_0008;
const FILE_DEVICE_DISK: u32 = 0x0000_0007;
const FILE_REMOTE_DEVICE: u32 = 0x0000_0010;
const FILE_FS_DEVICE_INFORMATION_CLASS: i32 = 4;

#[repr(C)]
struct FileFsDeviceInformation {
    device_type: u32,
    characteristics: u32,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryVolumeInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IO_STATUS_BLOCK,
        file_system_information: *mut c_void,
        length: u32,
        file_system_information_class: i32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: this wrapper uniquely owns the valid handle.
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct OpenedPath {
    handle: OwnedHandle,
    canonical_path: String,
    ancestry_reparse_free: bool,
}

struct PrefixObservation {
    path: String,
    canonical_path: String,
    object: WindowsObjectObservation,
}

pub(crate) fn inspect_windows_path(path: &str) -> NativeResult<WindowsPathInspection> {
    let opened = open_admitted_path(path, FILE_READ_ATTRIBUTES)?;
    let before = snapshot(opened.handle.0)?;
    let volume = inspect_volume(opened.handle.0, &opened.canonical_path, &before)?;
    let after = snapshot(opened.handle.0)?;
    if !same_stable_observation(&before, &after) {
        return Err(native_error(
            "ERR_WIN32_READ_CHANGED",
            "path identity or metadata changed while it was inspected",
        ));
    }
    Ok(WindowsPathInspection {
        canonical_path: opened.canonical_path,
        kind: if before.directory {
            "directory".to_owned()
        } else {
            "regular-file".to_owned()
        },
        volume,
        object: after,
        ancestry_reparse_free: opened.ancestry_reparse_free,
    })
}

pub(crate) fn read_windows_file_stable(path: &str, max_bytes: u32) -> NativeResult<StableReadData> {
    let opened = open_admitted_path(path, GENERIC_READ | FILE_READ_ATTRIBUTES)?;
    let before = snapshot(opened.handle.0)?;
    if before.directory {
        return Err(native_error(
            "ERR_WIN32_NOT_REGULAR_FILE",
            "stable read requires a regular file",
        ));
    }
    let _volume = inspect_volume(opened.handle.0, &opened.canonical_path, &before)?;
    let expected = parse_nonnegative_hex_u64(&before.size)?;
    if expected > u64::from(max_bytes) {
        return Err(native_error(
            "ERR_WIN32_READ_LIMIT",
            "stable read input exceeds the supplied byte bound",
        ));
    }

    let expected_usize = usize::try_from(expected).map_err(|_| {
        native_error(
            "ERR_WIN32_READ_LIMIT",
            "stable read input cannot be represented by this process",
        )
    })?;
    let mut bytes = vec![0_u8; expected_usize];
    let mut offset = 0_usize;
    while offset < bytes.len() {
        let remaining = bytes.len() - offset;
        let request = u32::try_from(remaining).unwrap_or(u32::MAX);
        let mut read = 0_u32;
        // SAFETY: the synchronous handle is valid and uniquely owned, the
        // writable slice covers request bytes, and the output count is valid.
        let success = unsafe {
            ReadFile(
                opened.handle.0,
                bytes.as_mut_ptr().add(offset).cast(),
                request,
                &mut read,
                null_mut(),
            )
        };
        if success == 0 {
            return Err(last_win_error("read stable file"));
        }
        if read == 0 {
            return Err(native_error(
                "ERR_WIN32_READ_INCOMPLETE",
                "stable read ended before the observed file size",
            ));
        }
        offset = offset.checked_add(read as usize).ok_or_else(|| {
            native_error("ERR_WIN32_READ_LIMIT", "stable read byte count overflowed")
        })?;
    }

    if expected < u64::from(max_bytes) {
        let mut extra = 0_u8;
        let mut read = 0_u32;
        // SAFETY: the synchronous handle remains positioned after the admitted
        // bytes and the one-byte destination is writable.
        let success = unsafe {
            ReadFile(
                opened.handle.0,
                (&mut extra as *mut u8).cast(),
                1,
                &mut read,
                null_mut(),
            )
        };
        if success == 0 {
            return Err(last_win_error("probe stable file growth"));
        }
        if read != 0 {
            return Err(native_error(
                "ERR_WIN32_READ_CHANGED",
                "stable read detected growth beyond the observed file size",
            ));
        }
    }

    let after = snapshot(opened.handle.0)?;
    if bytes.len() as u64 != expected
        || parse_nonnegative_hex_u64(&after.size)? != bytes.len() as u64
        || !same_stable_observation(&before, &after)
    {
        return Err(native_error(
            "ERR_WIN32_READ_CHANGED",
            "file identity, metadata, size, or byte count changed during stable read",
        ));
    }

    Ok(StableReadData {
        bytes,
        before,
        after,
    })
}

fn open_admitted_path(path: &str, final_access: u32) -> NativeResult<OpenedPath> {
    validate_input_path(path)?;
    let full = full_path(path)?;
    let (drive_root, prefixes) = admitted_prefixes(&full)?;
    reject_subst_or_device_alias(&drive_root)?;
    let last = prefixes.len().checked_sub(1).ok_or_else(|| {
        native_error(
            "ERR_WIN32_INVALID_PATH",
            "absolute Windows path has no openable root",
        )
    })?;
    let mut final_handle = None;
    let mut observations = Vec::with_capacity(prefixes.len());
    for (index, prefix) in prefixes.iter().enumerate() {
        let access = if index == last {
            final_access
        } else {
            FILE_READ_ATTRIBUTES
        };
        let handle = open_existing(prefix, access)?;
        let tag = attribute_tag(handle.0)?;
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(native_error(
                "ERR_WIN32_REPARSE_REFUSED",
                "Windows path contains an unsupported reparse point",
            ));
        }
        if index != last && tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(native_error(
                "ERR_WIN32_NOT_DIRECTORY",
                "Windows path ancestry contains a non-directory entry",
            ));
        }
        observations.push(PrefixObservation {
            path: prefix.clone(),
            canonical_path: final_path(handle.0)?,
            object: snapshot(handle.0)?,
        });
        if index == last {
            final_handle = Some(handle);
        }
    }
    let handle = final_handle.expect("nonempty prefix list must retain final handle");
    for expected in &observations {
        let reopened = open_existing(&expected.path, FILE_READ_ATTRIBUTES)?;
        let canonical_path = final_path(reopened.0)?;
        let object = snapshot(reopened.0)?;
        if canonical_path != expected.canonical_path
            || !same_stable_observation(&expected.object, &object)
        {
            return Err(native_error(
                "ERR_WIN32_READ_CHANGED",
                "Windows path ancestry changed while it was inspected",
            ));
        }
    }
    let canonical_path = observations
        .last()
        .expect("nonempty prefix list has a final observation")
        .canonical_path
        .clone();
    Ok(OpenedPath {
        handle,
        canonical_path,
        ancestry_reparse_free: true,
    })
}

fn validate_input_path(path: &str) -> NativeResult<()> {
    if path.is_empty() || path.encode_utf16().any(|unit| unit == 0) {
        return Err(native_error(
            "ERR_WIN32_INVALID_PATH",
            "Windows path must be a nonempty string without NUL",
        ));
    }
    let folded = path.replace('/', "\\").to_ascii_lowercase();
    if folded.starts_with("\\\\") || folded.starts_with("\\\\?\\") || folded.starts_with("\\\\.\\")
    {
        return Err(native_error(
            "ERR_WIN32_UNSUPPORTED_TARGET",
            "UNC and device-namespace paths are outside the accepted Windows boundary",
        ));
    }
    let parsed = Path::new(path);
    if !parsed.is_absolute() {
        return Err(native_error(
            "ERR_WIN32_INVALID_PATH",
            "Windows path must be absolute",
        ));
    }
    Ok(())
}

fn full_path(path: &str) -> NativeResult<String> {
    let input = wide(path);
    // SAFETY: input is NUL-terminated; a zero-sized output query is supported.
    let needed = unsafe { GetFullPathNameW(input.as_ptr(), 0, null_mut(), null_mut()) };
    if needed == 0 {
        return Err(last_win_error("resolve absolute Windows path"));
    }
    let mut buffer = vec![0_u16; needed as usize + 1];
    // SAFETY: the buffer is writable and sized from the preceding query.
    let written = unsafe {
        GetFullPathNameW(
            input.as_ptr(),
            buffer.len() as u32,
            buffer.as_mut_ptr(),
            null_mut(),
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(last_win_error("resolve absolute Windows path"));
    }
    Ok(String::from_utf16_lossy(&buffer[..written as usize]))
}

fn admitted_prefixes(full: &str) -> NativeResult<(String, Vec<String>)> {
    let mut components = Path::new(full).components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) => letter as char,
            _ => {
                return Err(native_error(
                    "ERR_WIN32_UNSUPPORTED_TARGET",
                    "Windows path must use a local drive-letter namespace",
                ));
            }
        },
        _ => {
            return Err(native_error(
                "ERR_WIN32_INVALID_PATH",
                "Windows path has no drive-letter prefix",
            ));
        }
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(native_error(
            "ERR_WIN32_INVALID_PATH",
            "Windows path must be drive-absolute",
        ));
    }
    let drive_root = format!("{}:\\", drive.to_ascii_uppercase());
    let mut current = PathBuf::from(&drive_root);
    let mut prefixes = vec![drive_root.clone()];
    for component in components {
        match component {
            Component::Normal(segment) => {
                if segment.to_string_lossy().contains(':') {
                    return Err(native_error(
                        "ERR_WIN32_INVALID_PATH",
                        "Windows alternate data stream paths are not accepted",
                    ));
                }
                current.push(segment);
                prefixes.push(current.to_string_lossy().into_owned());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(native_error(
                    "ERR_WIN32_INVALID_PATH",
                    "normalized Windows path retained a parent component",
                ));
            }
            _ => {
                return Err(native_error(
                    "ERR_WIN32_INVALID_PATH",
                    "Windows path contains an unsupported component",
                ));
            }
        }
    }
    Ok((drive_root, prefixes))
}

fn reject_subst_or_device_alias(drive_root: &str) -> NativeResult<()> {
    let device = format!("{}:", drive_root.chars().next().unwrap_or(' '));
    let input = wide(&device);
    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: input is terminated and the output buffer is valid.
    let written =
        unsafe { QueryDosDeviceW(input.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if written == 0 {
        return Err(last_win_error("inspect Windows drive mapping"));
    }
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(written as usize);
    let target = String::from_utf16_lossy(&buffer[..end]).to_ascii_lowercase();
    if !target.starts_with("\\device\\harddiskvolume") {
        return Err(native_error(
            "ERR_WIN32_VOLUME_NOT_FIXED",
            "Windows drive is substituted, mapped, or otherwise not a fixed local volume",
        ));
    }
    Ok(())
}

fn open_existing(path: &str, access: u32) -> NativeResult<OwnedHandle> {
    let extended = extended_drive_path(path)?;
    let encoded = wide(&extended);
    // SAFETY: encoded is NUL-terminated and all pointer parameters are valid.
    let handle = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL
                | FILE_FLAG_BACKUP_SEMANTICS
                | FILE_FLAG_OPEN_REPARSE_POINT
                | if access & GENERIC_READ != 0 {
                    FILE_FLAG_SEQUENTIAL_SCAN
                } else {
                    0
                },
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_win_error(
            "open Windows path without following reparses",
        ));
    }
    Ok(OwnedHandle(handle))
}

fn extended_drive_path(path: &str) -> NativeResult<String> {
    if path.starts_with("\\\\") {
        return Err(native_error(
            "ERR_WIN32_UNSUPPORTED_TARGET",
            "network and device paths are outside the accepted Windows boundary",
        ));
    }
    Ok(format!("\\\\?\\{path}"))
}

fn inspect_volume(
    handle: HANDLE,
    canonical_path: &str,
    object: &WindowsObjectObservation,
) -> NativeResult<WindowsVolumeObservation> {
    let guid_path = volume_guid_root(canonical_path)?;
    let guid_wide = wide(&guid_path);
    // SAFETY: the volume GUID path is canonical, terminated, and has a trailing separator.
    let drive_type = unsafe { GetDriveTypeW(guid_wide.as_ptr()) };
    if drive_type != DRIVE_FIXED {
        return Err(native_error(
            if drive_type == 4 {
                "ERR_WIN32_VOLUME_REMOTE"
            } else {
                "ERR_WIN32_VOLUME_NOT_FIXED"
            },
            "Windows managed storage must be on a fixed local drive",
        ));
    }

    let mut filesystem = vec![0_u16; 32];
    let mut flags = 0_u32;
    // SAFETY: canonical volume root and output buffers are valid.
    let info_ok = unsafe {
        GetVolumeInformationByHandleW(
            handle,
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    };
    if info_ok == 0 {
        return Err(last_win_error("inspect Windows filesystem"));
    }
    let filesystem_name = nul_terminated_string(&filesystem)?;
    if !filesystem_name.eq_ignore_ascii_case("NTFS") || flags & FILE_PERSISTENT_ACLS == 0 {
        return Err(native_error(
            "ERR_WIN32_FILESYSTEM_UNSUPPORTED",
            "Windows managed storage requires local NTFS with persistent ACL support",
        ));
    }

    let mut io: IO_STATUS_BLOCK = unsafe { zeroed() };
    let mut device: FileFsDeviceInformation = unsafe { zeroed() };
    // SAFETY: handle is valid and the fixed-size result buffers live through the call.
    let status = unsafe {
        NtQueryVolumeInformationFile(
            handle,
            &mut io,
            (&mut device as *mut FileFsDeviceInformation).cast(),
            size_of::<FileFsDeviceInformation>() as u32,
            FILE_FS_DEVICE_INFORMATION_CLASS,
        )
    };
    if status < 0 {
        // SAFETY: ntdll maps the returned NTSTATUS to a Win32 error number.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(win_error(code, "inspect Windows volume device"));
    }
    if device.device_type != FILE_DEVICE_DISK || device.characteristics & FILE_REMOTE_DEVICE != 0 {
        return Err(native_error(
            "ERR_WIN32_VOLUME_REMOTE",
            "Windows volume is remote or not a local disk device",
        ));
    }

    Ok(WindowsVolumeObservation {
        identity: object.volume_identity.clone(),
        filesystem_name: "NTFS".to_owned(),
        drive_type: "fixed".to_owned(),
        canonical_volume_guid_path: guid_path,
        remote_device: false,
    })
}

fn snapshot(handle: HANDLE) -> NativeResult<WindowsObjectObservation> {
    let tag = attribute_tag(handle)?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(native_error(
            "ERR_WIN32_REPARSE_REFUSED",
            "Windows object is an unsupported reparse point",
        ));
    }
    let id: FILE_ID_INFO = query_file_information(handle, FileIdInfo, "query file identity")?;
    let basic: FILE_BASIC_INFO =
        query_file_information(handle, FileBasicInfo, "query basic file metadata")?;
    let standard: FILE_STANDARD_INFO =
        query_file_information(handle, FileStandardInfo, "query standard file metadata")?;
    if standard.EndOfFile < 0 || standard.AllocationSize < 0 {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows object reported a negative file size",
        ));
    }
    if standard.DeletePending {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows object is pending deletion",
        ));
    }
    Ok(WindowsObjectObservation {
        volume_identity: hex_u64(id.VolumeSerialNumber),
        file_id: hex_bytes(&id.FileId.Identifier),
        size: hex_u64(standard.EndOfFile as u64),
        allocation_size: hex_u64(standard.AllocationSize as u64),
        number_of_links: format!("{:08x}", standard.NumberOfLinks),
        creation_time: hex_i64_bits(basic.CreationTime),
        last_access_time: hex_i64_bits(basic.LastAccessTime),
        last_write_time: hex_i64_bits(basic.LastWriteTime),
        change_time: hex_i64_bits(basic.ChangeTime),
        attributes: basic.FileAttributes,
        reparse_tag: 0,
        delete_pending: false,
        directory: standard.Directory,
    })
}

fn attribute_tag(handle: HANDLE) -> NativeResult<FILE_ATTRIBUTE_TAG_INFO> {
    query_file_information(handle, FileAttributeTagInfo, "query reparse attributes")
}

fn query_file_information<T>(
    handle: HANDLE,
    class: windows_sys::Win32::Storage::FileSystem::FILE_INFO_BY_HANDLE_CLASS,
    operation: &str,
) -> NativeResult<T> {
    let mut value: T = unsafe { zeroed() };
    // SAFETY: value is the exact structure required by class and is writable.
    let success = unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut value as *mut T).cast(),
            size_of::<T>() as u32,
        )
    };
    if success == 0 {
        return Err(last_win_error(operation));
    }
    Ok(value)
}

fn volume_guid_root(canonical_path: &str) -> NativeResult<String> {
    const PREFIX: &str = "\\\\?\\Volume{";
    if !canonical_path.starts_with(PREFIX) {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows did not return a canonical volume GUID path",
        ));
    }
    let end = canonical_path.find("}\\").ok_or_else(|| {
        native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned a malformed canonical volume GUID path",
        )
    })?;
    let root_end = end.checked_add(2).ok_or_else(|| {
        native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows volume GUID path length overflowed",
        )
    })?;
    Ok(canonical_path[..root_end].to_owned())
}

fn final_path(handle: HANDLE) -> NativeResult<String> {
    // SAFETY: zero-length query asks Windows for the required UTF-16 length.
    let needed = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_GUID,
        )
    };
    if needed == 0 {
        return Err(last_win_error("size canonical Windows path"));
    }
    let mut buffer = vec![0_u16; needed as usize + 1];
    // SAFETY: output buffer is sized from the preceding query.
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_GUID,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(last_win_error("resolve canonical Windows path"));
    }
    Ok(String::from_utf16_lossy(&buffer[..written as usize]))
}

fn same_stable_observation(
    before: &WindowsObjectObservation,
    after: &WindowsObjectObservation,
) -> bool {
    before.volume_identity == after.volume_identity
        && before.file_id == after.file_id
        && before.size == after.size
        && before.allocation_size == after.allocation_size
        && before.number_of_links == after.number_of_links
        && before.creation_time == after.creation_time
        && before.last_write_time == after.last_write_time
        && before.change_time == after.change_time
        && before.attributes == after.attributes
        && before.reparse_tag == after.reparse_tag
        && before.delete_pending == after.delete_pending
        && before.directory == after.directory
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn nul_terminated_string(buffer: &[u16]) -> NativeResult<String> {
    let end = buffer.iter().position(|unit| *unit == 0).ok_or_else(|| {
        native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned a non-terminated text result",
        )
    })?;
    Ok(String::from_utf16_lossy(&buffer[..end]))
}

fn hex_u64(value: u64) -> String {
    format!("{value:016x}")
}

fn hex_i64_bits(value: i64) -> String {
    format!("{:016x}", value as u64)
}

fn hex_bytes(value: &[u8]) -> String {
    let mut result = String::with_capacity(value.len() * 2);
    for byte in value {
        use std::fmt::Write as _;
        write!(&mut result, "{byte:02x}").expect("writing to String cannot fail");
    }
    result
}

fn parse_nonnegative_hex_u64(value: &str) -> NativeResult<u64> {
    u64::from_str_radix(value, 16).map_err(|_| {
        native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "native file size receipt is invalid",
        )
    })
}

fn last_win_error(operation: &str) -> Error<String> {
    // SAFETY: reads the calling thread's immediately preceding Win32 error.
    win_error(unsafe { GetLastError() }, operation)
}

fn win_error(code: u32, operation: &str) -> Error<String> {
    let stable = match code {
        ERROR_SHARING_VIOLATION => "ERR_WIN32_SHARING_VIOLATION",
        ERROR_ACCESS_DENIED => "ERR_WIN32_ACCESS_DENIED",
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "ERR_WIN32_PATH_NOT_FOUND",
        _ => "ERR_WIN32_IO",
    };
    native_error(
        stable,
        format!("{operation} failed with Windows error {code}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_hex_preserves_values_above_javascript_safe_integer_range() {
        assert_eq!(hex_u64(9_007_199_254_740_993), "0020000000000001");
        assert_eq!(hex_bytes(&[0, 1, 0xfe, 0xff]), "0001feff");
    }

    #[test]
    fn stable_comparison_ignores_access_time_but_not_change_time() {
        let before = observation();
        let mut access_only = observation();
        access_only.last_access_time = "0000000000000002".to_owned();
        assert!(same_stable_observation(&before, &access_only));
        access_only.change_time = "0000000000000002".to_owned();
        assert!(!same_stable_observation(&before, &access_only));
    }

    fn observation() -> WindowsObjectObservation {
        WindowsObjectObservation {
            volume_identity: "0020000000000001".to_owned(),
            file_id: "00000000000000002000000000000001".to_owned(),
            size: "0000000000000001".to_owned(),
            allocation_size: "0000000000001000".to_owned(),
            number_of_links: "00000001".to_owned(),
            creation_time: "0000000000000001".to_owned(),
            last_access_time: "0000000000000001".to_owned(),
            last_write_time: "0000000000000001".to_owned(),
            change_time: "0000000000000001".to_owned(),
            attributes: FILE_ATTRIBUTE_NORMAL,
            reparse_tag: 0,
            delete_pending: false,
            directory: false,
        }
    }
}
