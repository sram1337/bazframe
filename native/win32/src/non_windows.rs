use crate::{NativeResult, StableReadData, WindowsPathInspection, native_error};

pub(crate) fn inspect_windows_path(_path: &str) -> NativeResult<WindowsPathInspection> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native Windows path inspection requires win32-x64-msvc",
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
