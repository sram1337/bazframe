use crate::{
    DirectoryEnumerationData, NativeResult, StableReadData, WindowsPathInspection,
    WindowsPrivateDirectoryCreationReceipt, native_error,
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
