// Windows HANDLE/reparse techniques are adapted from @openclaw/fs-safe 0.7.2
// (Copyright (c) 2026 openclaw, MIT). See ../OPENCLAW-LICENSE.

use std::collections::HashSet;
use std::ffi::{OsStr, c_void};
use std::mem::{align_of, offset_of, size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};

use napi::Error;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS,
    ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_FILES, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION, ERROR_SUCCESS, GENERIC_READ, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    GROUP_SECURITY_INFORMATION, GetAclInformation, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetSecurityDescriptorGroup, GetSecurityDescriptorOwner,
    GetSidIdentifierAuthority, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
    IsValidAcl, IsValidSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN,
    FILE_ID_EXTD_DIR_INFO, FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
    FileAttributeTagInfo, FileBasicInfo, FileIdExtdDirectoryInfo, FileIdExtdDirectoryRestartInfo,
    FileIdInfo, FileStandardInfo, GetDriveTypeW, GetFileInformationByHandleEx,
    GetFinalPathNameByHandleW, GetFullPathNameW, GetVolumeInformationByHandleW, OPEN_EXISTING,
    QueryDosDeviceW, READ_CONTROL, ReadFile, VOLUME_NAME_GUID,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::{
    DirectoryEntryData, DirectoryEnumerationData, NativeResult, StableReadData,
    WindowsObjectObservation, WindowsPathInspection, WindowsPrivateDirectoryCreationReceipt,
    WindowsSecurityObservation, WindowsVolumeObservation, native_error,
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

struct OwnedLocal(*mut c_void);

impl Drop for OwnedLocal {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper uniquely owns LocalAlloc memory returned by a Win32 API.
            unsafe { LocalFree(self.0) };
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawDirectoryEntry {
    name: Vec<u16>,
    file_id: String,
    size: String,
    allocation_size: String,
    creation_time: String,
    last_write_time: String,
    change_time: String,
    attributes: u32,
    reparse_tag: u32,
    directory: bool,
}

pub(crate) fn inspect_windows_path(path: &str) -> NativeResult<WindowsPathInspection> {
    let opened = open_admitted_path(path, FILE_READ_ATTRIBUTES | READ_CONTROL)?;
    inspect_opened_path(&opened)
}

pub(crate) fn create_windows_private_directory(
    parent_path: &str,
    final_component: &str,
) -> NativeResult<WindowsPrivateDirectoryCreationReceipt> {
    let parent = open_admitted_path(parent_path, FILE_READ_ATTRIBUTES | READ_CONTROL)?;
    let parent_before = inspect_opened_path(&parent)?;
    if parent_before.kind != "directory" {
        return Err(native_error(
            "ERR_WIN32_NOT_DIRECTORY",
            "private-directory creation requires a directory parent",
        ));
    }

    let target_path = join_direct_child(parent_path, final_component);
    let target_extended = extended_drive_path(&target_path)?;
    let descriptor = private_security_descriptor(&parent_before.security.current_user_sid)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let encoded = wide(&target_extended);
    // SAFETY: the path and security descriptor are terminated/valid and both
    // remain alive for the complete no-replace creation call.
    let created = unsafe { CreateDirectoryW(encoded.as_ptr(), &mut attributes) };
    if created == 0 {
        return Err(last_win_error("create protected Windows directory"));
    }

    finish_private_directory_creation(parent, parent_before, &target_path, final_component).map_err(
        |_| {
            native_error(
                "ERR_WIN32_CREATE_AMBIGUOUS",
                "private-directory creation succeeded but its result could not be proved",
            )
        },
    )
}

fn inspect_opened_path(opened: &OpenedPath) -> NativeResult<WindowsPathInspection> {
    let before = snapshot(opened.handle.0)?;
    let security_before = inspect_security(opened.handle.0)?;
    let volume = inspect_volume(opened.handle.0, &opened.canonical_path, &before)?;
    let security_after = inspect_security(opened.handle.0)?;
    let after = snapshot(opened.handle.0)?;
    if !same_stable_observation(&before, &after)
        || !same_security_observation(&security_before, &security_after)
    {
        return Err(native_error(
            "ERR_WIN32_READ_CHANGED",
            "path identity, metadata, or security changed while it was inspected",
        ));
    }
    Ok(WindowsPathInspection {
        canonical_path: opened.canonical_path.clone(),
        kind: if before.directory {
            "directory".to_owned()
        } else {
            "regular-file".to_owned()
        },
        volume,
        object: after,
        security: security_after,
        ancestry_reparse_free: opened.ancestry_reparse_free,
    })
}

fn finish_private_directory_creation(
    parent: OpenedPath,
    parent_before: WindowsPathInspection,
    target_path: &str,
    final_component: &str,
) -> NativeResult<WindowsPrivateDirectoryCreationReceipt> {
    let parent_after = inspect_opened_path(&parent)?;
    let created = inspect_windows_path(target_path)?;
    let separator = if parent_before.canonical_path.ends_with('\\') {
        ""
    } else {
        "\\"
    };
    let expected_child = format!(
        "{}{}{}",
        parent_before.canonical_path, separator, final_component
    );
    if !same_directory_identity(&parent_before, &parent_after)
        || !same_security_observation(&parent_before.security, &parent_after.security)
        || created.kind != "directory"
        || created.volume.identity != parent_before.volume.identity
        || created.object.volume_identity != parent_before.object.volume_identity
        || created.canonical_path != expected_child
    {
        return Err(native_error(
            "ERR_WIN32_CREATE_AMBIGUOUS",
            "private-directory creation result was not the requested stable direct child",
        ));
    }
    Ok(WindowsPrivateDirectoryCreationReceipt {
        parent_before,
        created,
        parent_after,
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

pub(crate) fn enumerate_windows_directory_stable(
    path: &str,
    max_entries: u32,
) -> NativeResult<DirectoryEnumerationData> {
    let opened = open_admitted_path(
        path,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    )?;
    let directory_before = inspect_opened_path(&opened)?;
    if directory_before.kind != "directory" {
        return Err(native_error(
            "ERR_WIN32_NOT_DIRECTORY",
            "stable directory enumeration requires a directory",
        ));
    }

    let first = enumerate_directory_pass(opened.handle.0, max_entries)?;
    let second = enumerate_directory_pass(opened.handle.0, max_entries)?;
    if first != second {
        return Err(native_error(
            "ERR_WIN32_ENUMERATION_CHANGED",
            "directory entries changed between stable enumeration passes",
        ));
    }

    let directory_after = inspect_opened_path(&opened)?;
    let current = inspect_windows_path(path)?;
    if !same_path_inspection(&directory_before, &directory_after)
        || !same_path_inspection(&directory_after, &current)
    {
        return Err(native_error(
            "ERR_WIN32_ENUMERATION_CHANGED",
            "directory identity, metadata, security, or ancestry changed during enumeration",
        ));
    }

    Ok(DirectoryEnumerationData {
        directory_before,
        entries: second
            .into_iter()
            .map(|entry| DirectoryEntryData {
                name: entry.name,
                file_id: entry.file_id,
                size: entry.size,
                allocation_size: entry.allocation_size,
                creation_time: entry.creation_time,
                last_write_time: entry.last_write_time,
                change_time: entry.change_time,
                attributes: entry.attributes,
                reparse_tag: entry.reparse_tag,
                directory: entry.directory,
            })
            .collect(),
        directory_after,
    })
}

const DIRECTORY_ENUMERATION_BUFFER_BYTES: usize = 64 * 1024;

fn enumerate_directory_pass(
    handle: HANDLE,
    max_entries: u32,
) -> NativeResult<Vec<RawDirectoryEntry>> {
    let word_count = DIRECTORY_ENUMERATION_BUFFER_BYTES.div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; word_count];
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    let mut restart = true;
    loop {
        storage.fill(0);
        let class = if restart {
            FileIdExtdDirectoryRestartInfo
        } else {
            FileIdExtdDirectoryInfo
        };
        // SAFETY: storage is pointer-aligned, writable for its full fixed size,
        // and the information class writes FILE_ID_EXTD_DIR_INFO records.
        let success = unsafe {
            GetFileInformationByHandleEx(
                handle,
                class,
                storage.as_mut_ptr().cast(),
                DIRECTORY_ENUMERATION_BUFFER_BYTES as u32,
            )
        };
        restart = false;
        if success == 0 {
            // SAFETY: reads the error from the immediately preceding Win32 call.
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_FILES {
                break;
            }
            return Err(win_error(code, "enumerate Windows directory"));
        }

        let parsed = parse_directory_buffer(&storage)?;
        if parsed.is_empty() {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned a successful empty directory-enumeration buffer",
            ));
        }
        append_directory_entries(parsed, max_entries, &mut names, &mut entries)?;
    }
    sort_directory_entries(&mut entries);
    Ok(entries)
}

fn sort_directory_entries(entries: &mut [RawDirectoryEntry]) {
    entries.sort_by(|left, right| left.name.cmp(&right.name));
}

fn append_directory_entries(
    parsed: Vec<RawDirectoryEntry>,
    max_entries: u32,
    names: &mut HashSet<Vec<u16>>,
    entries: &mut Vec<RawDirectoryEntry>,
) -> NativeResult<()> {
    for entry in parsed {
        if entry.name == [b'.' as u16] || entry.name == [b'.' as u16, b'.' as u16] {
            continue;
        }
        if entries.len() >= max_entries as usize {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_LIMIT",
                "directory contains more entries than the supplied bound",
            ));
        }
        if !names.insert(entry.name.clone()) {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned a duplicate directory entry",
            ));
        }
        entries.push(entry);
    }
    Ok(())
}

fn parse_directory_buffer(storage: &[usize]) -> NativeResult<Vec<RawDirectoryEntry>> {
    let bytes = storage
        .len()
        .checked_mul(size_of::<usize>())
        .ok_or_else(|| {
            native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "directory buffer size overflowed",
            )
        })?;
    let base = storage.as_ptr().cast::<u8>();
    let header = offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);
    let alignment = align_of::<FILE_ID_EXTD_DIR_INFO>();
    let mut offset = 0_usize;
    let mut result = Vec::new();
    loop {
        if offset % alignment != 0 || offset.checked_add(header).is_none_or(|end| end > bytes) {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned a truncated or misaligned directory record",
            ));
        }
        // SAFETY: storage is aligned and the header range was checked above.
        let record = unsafe { &*base.add(offset).cast::<FILE_ID_EXTD_DIR_INFO>() };
        let name_bytes = record.FileNameLength as usize;
        if name_bytes == 0 || name_bytes % 2 != 0 {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned an invalid directory entry name length",
            ));
        }
        let record_bytes = header.checked_add(name_bytes).ok_or_else(|| {
            native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "directory entry length overflowed",
            )
        })?;
        if offset
            .checked_add(record_bytes)
            .is_none_or(|end| end > bytes)
        {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned a truncated directory entry name",
            ));
        }
        let name_units = name_bytes / 2;
        // SAFETY: the filename range was checked and WCHAR has u16 alignment.
        let name = unsafe {
            std::slice::from_raw_parts(base.add(offset + header).cast::<u16>(), name_units)
        }
        .to_vec();
        if name.iter().any(|unit| *unit == 0) || String::from_utf16(&name).is_err() {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned an invalid UTF-16 directory entry name",
            ));
        }
        if record.EndOfFile < 0 || record.AllocationSize < 0 {
            return Err(native_error(
                "ERR_WIN32_METADATA_UNAVAILABLE",
                "Windows directory entry reported a negative size",
            ));
        }
        let reparse = record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        if reparse && record.ReparsePointTag == 0 {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned a reparse entry without a reparse tag",
            ));
        }
        result.push(RawDirectoryEntry {
            name,
            file_id: hex_bytes(&record.FileId.Identifier),
            size: hex_u64(record.EndOfFile as u64),
            allocation_size: hex_u64(record.AllocationSize as u64),
            creation_time: hex_i64_bits(record.CreationTime),
            last_write_time: hex_i64_bits(record.LastWriteTime),
            change_time: hex_i64_bits(record.ChangeTime),
            attributes: record.FileAttributes,
            reparse_tag: if reparse { record.ReparsePointTag } else { 0 },
            directory: record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        });

        let next = record.NextEntryOffset as usize;
        if next == 0 {
            return Ok(result);
        }
        if next % alignment != 0 || next < record_bytes {
            return Err(native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "Windows returned an invalid next directory-entry offset",
            ));
        }
        offset = offset.checked_add(next).ok_or_else(|| {
            native_error(
                "ERR_WIN32_ENUMERATION_INCOMPLETE",
                "directory-entry offset overflowed",
            )
        })?;
    }
}

fn same_path_inspection(a: &WindowsPathInspection, b: &WindowsPathInspection) -> bool {
    a.canonical_path == b.canonical_path
        && a.kind == "directory"
        && b.kind == "directory"
        && a.ancestry_reparse_free
        && b.ancestry_reparse_free
        && a.volume.identity == b.volume.identity
        && a.volume.filesystem_name == b.volume.filesystem_name
        && a.volume.drive_type == b.volume.drive_type
        && a.volume.canonical_volume_guid_path == b.volume.canonical_volume_guid_path
        && a.volume.remote_device == b.volume.remote_device
        && same_stable_observation(&a.object, &b.object)
        && same_security_observation(&a.security, &b.security)
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

fn inspect_security(handle: HANDLE) -> NativeResult<WindowsSecurityObservation> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: the handle is valid and the descriptor output pointer is writable.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(win_error(status, "query Windows object security"));
    }
    if descriptor.is_null() {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned no object security descriptor",
        ));
    }
    let _descriptor_owner = OwnedLocal(descriptor);

    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: descriptor is valid LocalAlloc memory returned by GetSecurityInfo.
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(last_win_error("query Windows security descriptor control"));
    }

    let mut owner: PSID = null_mut();
    let mut owner_defaulted = 0;
    // SAFETY: descriptor and output pointers are valid.
    if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut owner_defaulted) } == 0 {
        return Err(last_win_error("query Windows security descriptor owner"));
    }
    if owner.is_null() {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned no object owner security identifier",
        ));
    }
    let mut group: PSID = null_mut();
    let mut group_defaulted = 0;
    // SAFETY: descriptor and output pointers are valid.
    if unsafe { GetSecurityDescriptorGroup(descriptor, &mut group, &mut group_defaulted) } == 0 {
        return Err(last_win_error("query Windows security descriptor group"));
    }
    if group.is_null() {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned no object group security identifier",
        ));
    }
    let mut dacl_present = 0;
    let mut dacl_defaulted = 0;
    let mut dacl: *mut ACL = null_mut();
    // SAFETY: descriptor and output pointers are valid.
    if unsafe {
        GetSecurityDescriptorDacl(
            descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    } == 0
    {
        return Err(last_win_error("query Windows security descriptor DACL"));
    }

    let dacl_bytes = if dacl_present != 0 && !dacl.is_null() {
        // SAFETY: DACL points within the live descriptor and IsValidAcl validates its header.
        if unsafe { IsValidAcl(dacl) } == 0 {
            return Err(native_error(
                "ERR_WIN32_METADATA_UNAVAILABLE",
                "Windows returned an invalid object DACL",
            ));
        }
        let mut size_info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
        // SAFETY: DACL is valid and size_info is the exact requested output structure.
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut size_info as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(last_win_error("query Windows DACL size"));
        }
        // SAFETY: IsValidAcl succeeded, so reading the fixed ACL header is valid.
        let declared_size = unsafe { (*dacl).AclSize } as usize;
        if declared_size < size_of::<ACL>()
            || size_info.AclBytesInUse < size_of::<ACL>() as u32
            || size_info.AclBytesInUse as usize > declared_size
        {
            return Err(native_error(
                "ERR_WIN32_METADATA_UNAVAILABLE",
                "Windows returned inconsistent object DACL sizing",
            ));
        }
        let bytes_in_use = size_info.AclBytesInUse as usize;
        // SAFETY: the validated ACL reports bytes_in_use within its declared live allocation.
        let mut bytes =
            unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), bytes_in_use) }.to_vec();
        // Unused ACL capacity is not security evidence and may contain unstable padding. Expose a
        // canonical complete ACL whose declared size is exactly the bytes that contain its ACEs.
        bytes[2..4].copy_from_slice(&(bytes_in_use as u16).to_le_bytes());
        bytes
    } else {
        Vec::new()
    };

    Ok(WindowsSecurityObservation {
        descriptor_control: u32::from(control),
        dacl_present: dacl_present != 0,
        dacl_null: dacl_present != 0 && dacl.is_null(),
        dacl_defaulted: dacl_defaulted != 0,
        dacl_bytes: dacl_bytes.into(),
        owner_sid: sid_string(owner)?,
        owner_defaulted: owner_defaulted != 0,
        group_sid: sid_string(group)?,
        group_defaulted: group_defaulted != 0,
        current_user_sid: current_user_sid()?,
    })
}

fn current_user_sid() -> NativeResult<String> {
    let mut token = null_mut();
    // SAFETY: process pseudo-handle is valid and token output is writable.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_win_error("open current Windows process token"));
    }
    let token = OwnedHandle(token);
    let mut needed = 0_u32;
    // SAFETY: zero-length query requests the required TOKEN_USER buffer size.
    let first = unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed) };
    if first != 0 || needed < size_of::<TOKEN_USER>() as u32 {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned an invalid current-user token size",
        ));
    }
    // SAFETY: reads the immediately preceding sizing call's error.
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(last_win_error("size current Windows user token"));
    }
    let word = size_of::<usize>();
    let words = (needed as usize).div_ceil(word);
    let mut buffer = vec![0_usize; words];
    let mut returned = 0_u32;
    // SAFETY: the aligned buffer has at least needed writable bytes.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut returned,
        )
    } == 0
    {
        return Err(last_win_error("query current Windows user token"));
    }
    if returned < size_of::<TOKEN_USER>() as u32 || returned > needed {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned inconsistent current-user token bytes",
        ));
    }
    // SAFETY: the successful TOKEN_USER query wrote the aligned fixed header.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_string(user.User.Sid)
}

fn sid_string(sid: PSID) -> NativeResult<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned an invalid security identifier",
        ));
    }
    // SAFETY: the validated SID exposes a fixed identifier authority pointer.
    let authority = unsafe { GetSidIdentifierAuthority(sid) };
    // SAFETY: the validated SID exposes a one-byte subauthority count pointer.
    let count_pointer = unsafe { GetSidSubAuthorityCount(sid) };
    if authority.is_null() || count_pointer.is_null() {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned incomplete security identifier metadata",
        ));
    }
    // SAFETY: both pointers refer into the validated live SID.
    let authority_bytes = unsafe { (*authority).Value };
    let count = unsafe { *count_pointer };
    if count > 15 {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned an oversized security identifier",
        ));
    }
    let authority_value = authority_bytes
        .into_iter()
        .fold(0_u64, |value, byte| (value << 8) | u64::from(byte));
    let mut value = format!("S-1-{authority_value}");
    for index in 0..u32::from(count) {
        // SAFETY: index is below the validated SID's declared subauthority count.
        let subauthority = unsafe { GetSidSubAuthority(sid, index) };
        if subauthority.is_null() {
            return Err(native_error(
                "ERR_WIN32_METADATA_UNAVAILABLE",
                "Windows returned incomplete security identifier metadata",
            ));
        }
        use std::fmt::Write as _;
        // SAFETY: the pointer refers to the indexed subauthority in the validated SID.
        write!(&mut value, "-{}", unsafe { *subauthority }).expect("writing to String cannot fail");
    }
    Ok(value)
}

fn private_security_descriptor(current_user_sid: &str) -> NativeResult<OwnedLocal> {
    // Leave the primary group unset so Windows assigns the creator token's valid
    // primary group; TOKEN_USER is not necessarily assignable as an object group.
    let sddl = format!(
        "O:{0}D:P(A;OICI;FA;;;{0})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
        current_user_sid
    );
    let encoded = wide(&sddl);
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let mut size = 0_u32;
    // SAFETY: SDDL is terminated and output pointers are writable.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            encoded.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            &mut size,
        )
    } == 0
    {
        return Err(last_win_error(
            "construct protected Windows security descriptor",
        ));
    }
    if descriptor.is_null() {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned no protected security descriptor",
        ));
    }
    let descriptor = OwnedLocal(descriptor);
    if size == 0 {
        return Err(native_error(
            "ERR_WIN32_METADATA_UNAVAILABLE",
            "Windows returned an invalid protected security descriptor",
        ));
    }
    Ok(descriptor)
}

fn join_direct_child(parent: &str, component: &str) -> String {
    let separator = if parent.ends_with(['\\', '/']) {
        ""
    } else {
        "\\"
    };
    format!("{parent}{separator}{component}")
}

fn same_directory_identity(a: &WindowsPathInspection, b: &WindowsPathInspection) -> bool {
    a.canonical_path == b.canonical_path
        && a.kind == "directory"
        && b.kind == "directory"
        && a.volume.identity == b.volume.identity
        && a.object.volume_identity == b.object.volume_identity
        && a.object.file_id == b.object.file_id
        && a.object.reparse_tag == 0
        && b.object.reparse_tag == 0
        && !a.object.delete_pending
        && !b.object.delete_pending
        && a.object.directory
        && b.object.directory
}

fn same_security_observation(
    a: &WindowsSecurityObservation,
    b: &WindowsSecurityObservation,
) -> bool {
    a.descriptor_control == b.descriptor_control
        && a.dacl_present == b.dacl_present
        && a.dacl_null == b.dacl_null
        && a.dacl_defaulted == b.dacl_defaulted
        && a.dacl_bytes.as_ref() == b.dacl_bytes.as_ref()
        && a.owner_sid == b.owner_sid
        && a.owner_defaulted == b.owner_defaulted
        && a.group_sid == b.group_sid
        && a.group_defaulted == b.group_defaulted
        && a.current_user_sid == b.current_user_sid
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
        ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => "ERR_WIN32_ALREADY_EXISTS",
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

    #[test]
    fn parses_extended_directory_records_without_losing_utf16_or_identity() {
        let storage = directory_buffer(&[
            ("😀".encode_utf16().collect(), FILE_ATTRIBUTE_NORMAL, 0),
            (
                "link".encode_utf16().collect(),
                FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
                0xa000_0003,
            ),
        ]);
        let entries = parse_directory_buffer(&storage).expect("valid records");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "😀".encode_utf16().collect::<Vec<_>>());
        assert_eq!(entries[0].file_id, "000102030405060708090a0b0c0d0e0f");
        assert_eq!(entries[1].reparse_tag, 0xa000_0003);
        assert!(entries[1].directory);
    }

    #[test]
    fn rejects_malformed_directory_record_offsets_lengths_utf16_and_tags() {
        let mut offset =
            directory_buffer(&[("a".encode_utf16().collect(), FILE_ATTRIBUTE_NORMAL, 0)]);
        unsafe { (*offset.as_mut_ptr().cast::<FILE_ID_EXTD_DIR_INFO>()).NextEntryOffset = 2 };
        assert_native_code(
            parse_directory_buffer(&offset),
            "ERR_WIN32_ENUMERATION_INCOMPLETE",
        );

        let mut odd = directory_buffer(&[("a".encode_utf16().collect(), FILE_ATTRIBUTE_NORMAL, 0)]);
        unsafe { (*odd.as_mut_ptr().cast::<FILE_ID_EXTD_DIR_INFO>()).FileNameLength = 1 };
        assert_native_code(
            parse_directory_buffer(&odd),
            "ERR_WIN32_ENUMERATION_INCOMPLETE",
        );

        let invalid_utf16 = directory_buffer(&[(vec![0xd800], FILE_ATTRIBUTE_NORMAL, 0)]);
        assert_native_code(
            parse_directory_buffer(&invalid_utf16),
            "ERR_WIN32_ENUMERATION_INCOMPLETE",
        );

        let missing_tag = directory_buffer(&[(
            "link".encode_utf16().collect(),
            FILE_ATTRIBUTE_REPARSE_POINT,
            0,
        )]);
        assert_native_code(
            parse_directory_buffer(&missing_tag),
            "ERR_WIN32_ENUMERATION_INCOMPLETE",
        );
    }

    #[test]
    fn applies_dot_duplicate_limit_and_raw_utf16_ordering_rules() {
        let mut names = HashSet::new();
        let mut entries = Vec::new();
        append_directory_entries(
            vec![raw("."), raw(".."), raw("😀"), raw("z")],
            2,
            &mut names,
            &mut entries,
        )
        .expect("exact limit");
        assert_eq!(entries.len(), 2);
        sort_directory_entries(&mut entries);
        assert_eq!(entries[0].name, "z".encode_utf16().collect::<Vec<_>>());
        assert_eq!(entries[1].name, "😀".encode_utf16().collect::<Vec<_>>());

        assert_native_code(
            append_directory_entries(vec![raw("extra")], 2, &mut names, &mut entries),
            "ERR_WIN32_ENUMERATION_LIMIT",
        );

        let mut duplicate_names = HashSet::new();
        let mut duplicates = Vec::new();
        assert_native_code(
            append_directory_entries(
                vec![raw("same"), raw("same")],
                2,
                &mut duplicate_names,
                &mut duplicates,
            ),
            "ERR_WIN32_ENUMERATION_INCOMPLETE",
        );
    }

    fn directory_buffer(records: &[(Vec<u16>, u32, u32)]) -> Vec<usize> {
        let header = offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);
        let alignment = align_of::<FILE_ID_EXTD_DIR_INFO>();
        let aligned = |value: usize| value.div_ceil(alignment) * alignment;
        let sizes: Vec<usize> = records
            .iter()
            .map(|(name, _, _)| aligned(header + name.len() * 2))
            .collect();
        let bytes = sizes.iter().sum::<usize>().max(alignment);
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        let mut offset = 0_usize;
        for (index, (name, attributes, tag)) in records.iter().enumerate() {
            let record = unsafe {
                &mut *storage
                    .as_mut_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_EXTD_DIR_INFO>()
            };
            *record = FILE_ID_EXTD_DIR_INFO::default();
            record.NextEntryOffset = if index + 1 == records.len() {
                0
            } else {
                sizes[index] as u32
            };
            record.EndOfFile = 1;
            record.AllocationSize = 1;
            record.FileAttributes = *attributes;
            record.FileNameLength = (name.len() * 2) as u32;
            record.ReparsePointTag = *tag;
            record.FileId.Identifier = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
            unsafe {
                std::ptr::copy_nonoverlapping(
                    name.as_ptr(),
                    storage
                        .as_mut_ptr()
                        .cast::<u8>()
                        .add(offset + header)
                        .cast::<u16>(),
                    name.len(),
                )
            };
            offset += sizes[index];
        }
        storage
    }

    fn raw(name: &str) -> RawDirectoryEntry {
        RawDirectoryEntry {
            name: name.encode_utf16().collect(),
            file_id: "000102030405060708090a0b0c0d0e0f".to_owned(),
            size: "0000000000000001".to_owned(),
            allocation_size: "0000000000000001".to_owned(),
            creation_time: "0000000000000001".to_owned(),
            last_write_time: "0000000000000001".to_owned(),
            change_time: "0000000000000001".to_owned(),
            attributes: FILE_ATTRIBUTE_NORMAL,
            reparse_tag: 0,
            directory: false,
        }
    }

    fn assert_native_code<T>(result: NativeResult<T>, expected: &str) {
        let error = result.err().expect("expected native refusal");
        assert_eq!(error.status, expected);
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
