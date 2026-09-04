use crate::{
    DirectoryEnumerationData, NativeResult, StableReadData, WindowsFileLockAcquisitionReceipt,
    WindowsPathInspection, WindowsPrivateDirectoryCreationReceipt,
    WindowsPrivateFileCreationReceipt, WindowsProcessInstanceInspectionReceipt, native_error,
};

pub(crate) fn inspect_windows_path(_path: &str) -> NativeResult<WindowsPathInspection> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native Windows path inspection requires win32-x64-msvc",
    ))
}

pub(crate) fn create_windows_private_directory(
    _parent_path: &str,
    _final_component: &str,
) -> NativeResult<WindowsPrivateDirectoryCreationReceipt> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native private-directory creation requires win32-x64-msvc",
    ))
}

pub(crate) fn create_windows_private_file(
    _parent_path: &str,
    _final_component: &str,
) -> NativeResult<WindowsPrivateFileCreationReceipt> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native private-file creation requires win32-x64-msvc",
    ))
}

pub(crate) fn acquire_windows_file_lock(
    _guard_path: &str,
    _environment: usize,
) -> NativeResult<WindowsFileLockAcquisitionReceipt> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native file locking requires win32-x64-msvc",
    ))
}

pub(crate) fn release_windows_file_lock(_token: &str) -> NativeResult<()> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native file locking requires win32-x64-msvc",
    ))
}

pub(crate) fn release_windows_file_locks_for_environment(_environment: usize) {}

pub(crate) fn inspect_windows_process_instance(
    _pid: u32,
    _creation_time: &str,
) -> NativeResult<WindowsProcessInstanceInspectionReceipt> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native process inspection requires win32-x64-msvc",
    ))
}

pub(crate) fn rename_windows_directory_no_replace(
    _parent_path: &str,
    _source_component: &str,
    _destination_component: &str,
) -> NativeResult<()> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native no-replace directory rename requires win32-x64-msvc",
    ))
}

pub(crate) fn read_windows_file_stable(
    _path: &str,
    _max_bytes: u32,
) -> NativeResult<StableReadData> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native stable reads require win32-x64-msvc",
    ))
}

pub(crate) fn enumerate_windows_directory_stable(
    _path: &str,
    _max_entries: u32,
) -> NativeResult<DirectoryEnumerationData> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native stable directory enumeration requires win32-x64-msvc",
    ))
}
