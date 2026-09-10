use crate::{
    DirectoryEnumerationData, NativeResult, StableReadData, WindowsFileLockAcquisitionReceipt,
    WindowsMembershipLinkInspection, WindowsPathInspection, WindowsPrivateDirectoryCreationReceipt,
    WindowsPrivateFileCreationReceipt, WindowsPrivateJunctionCreationReceipt,
    WindowsProcessInstanceInspectionReceipt, native_error,
};

pub(crate) fn inspect_windows_path(_path: &str) -> NativeResult<WindowsPathInspection> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native Windows path inspection requires win32-x64-msvc",
    ))
}

pub(crate) fn inspect_windows_membership_link(
    _path: &str,
) -> NativeResult<WindowsMembershipLinkInspection> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native Windows membership inspection requires win32-x64-msvc",
    ))
}

pub(crate) fn create_windows_private_junction(
    _parent_path: &str,
    _final_component: &str,
    _target_path: &str,
) -> NativeResult<WindowsPrivateJunctionCreationReceipt> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native private-junction creation requires win32-x64-msvc",
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

pub(crate) fn move_windows_directory_no_replace(
    _source_parent_path: &str,
    _source_component: &str,
    _destination_parent_path: &str,
    _destination_component: &str,
) -> NativeResult<()> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native no-replace directory move requires win32-x64-msvc",
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

pub(crate) fn rename_windows_file_no_replace(
    _parent_path: &str,
    _source_component: &str,
    _destination_component: &str,
) -> NativeResult<()> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native no-replace file rename requires win32-x64-msvc",
    ))
}

pub(crate) fn read_windows_file_range_stable(
    _path: &str,
    _offset: u32,
    _length: u32,
    _max_file_bytes: u32,
) -> NativeResult<StableReadData> {
    Err(native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "Bazframe native ranged reads require win32-x64-msvc",
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

#[cfg(test)]
mod tests {
    #[test]
    fn zip_source_classification_refuses_non_windows() {
        assert_eq!(
            super::inspect_windows_zip_source("C:\\source.zip")
                .err()
                .unwrap()
                .status,
            "ERR_WIN32_UNSUPPORTED_TARGET"
        );
    }

    #[test]
    fn ranged_reads_refuse_non_windows() {
        assert_eq!(
            super::read_windows_file_range_stable(
                "C:\\state\\archive.zip",
                64 * 1024 * 1024,
                32,
                1536 * 1024 * 1024
            )
            .err()
            .unwrap()
            .status,
            "ERR_WIN32_UNSUPPORTED_TARGET"
        );
    }

    #[test]
    fn no_replace_file_and_directory_variants_refuse_non_windows() {
        for result in [
            super::move_windows_directory_no_replace(
                "C:\\state",
                "candidate",
                "C:\\other",
                "profile",
            ),
            super::rename_windows_file_no_replace("C:\\state", "temporary", "digest"),
            super::rename_windows_directory_no_replace("C:\\state", "candidate", "profile"),
        ] {
            assert_eq!(result.unwrap_err().status, "ERR_WIN32_UNSUPPORTED_TARGET");
        }
    }
}

pub fn inspect_windows_zip_source(
    _path: &str,
) -> crate::NativeResult<crate::WindowsObjectObservation> {
    Err(crate::native_error(
        "ERR_WIN32_UNSUPPORTED_TARGET",
        "ZIP source classification requires Windows",
    ))
}

pub(crate) fn inspect_windows_editor_target(_root: &str, _path: &str) -> NativeResult<crate::WindowsEditorTargetInspection> {
    Err(native_error("ERR_WIN32_UNSUPPORTED_TARGET", "Windows editor inspection requires win32-x64-msvc"))
}
