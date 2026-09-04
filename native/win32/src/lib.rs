#![deny(unsafe_op_in_unsafe_fn)]

// Windows HANDLE/reparse and N-API error-bridging techniques are adapted from
// @openclaw/fs-safe 0.7.2 (Copyright (c) 2026 openclaw, MIT). See ../NOTICE.md
// and ../OPENCLAW-LICENSE. Bazframe owns this API and compiled artifact.

use napi::bindgen_prelude::{AsyncTask, Buffer, Task, Utf16String};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;

mod component;
#[cfg(not(windows))]
mod non_windows;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use non_windows as platform;
#[cfg(windows)]
use windows as platform;

pub const NATIVE_CONTRACT_VERSION: u32 = 2;
// Mirrors PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutFileBytes. The native
// boundary may lower a caller's bound but never allocates beyond this product
// authority.
pub const MAX_STABLE_READ_BYTES: u32 = 64 * 1024 * 1024;

pub(crate) type NativeResult<T> = std::result::Result<T, Error<String>>;

pub(crate) fn native_error(code: impl Into<String>, message: impl Into<String>) -> Error<String> {
    Error::new(code.into(), message.into())
}

pub(crate) fn into_napi<T>(env: Env, result: NativeResult<T>) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let reason = error.reason;
            env.throw_error(&reason, Some(error.status.as_ref()))?;
            Err(Error::new(Status::PendingException, reason))
        }
    }
}

fn into_async_napi<T>(result: NativeResult<T>) -> Result<T> {
    result.map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("{}: {}", error.status, error.reason),
        )
    })
}

#[napi(object)]
pub struct NativeWindowsInfo {
    pub contract_version: u32,
    pub package_version: String,
    pub target: String,
    pub max_stable_read_bytes: u32,
}

#[napi(object)]
pub struct WindowsVolumeObservation {
    pub identity: String,
    pub filesystem_name: String,
    pub drive_type: String,
    pub canonical_volume_guid_path: String,
    pub remote_device: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WindowsObjectObservation {
    pub volume_identity: String,
    pub file_id: String,
    pub size: String,
    pub allocation_size: String,
    pub number_of_links: String,
    pub creation_time: String,
    pub last_access_time: String,
    pub last_write_time: String,
    pub change_time: String,
    pub attributes: u32,
    /// Zero means no reparse tag; nonzero values are refused before success.
    pub reparse_tag: u32,
    pub delete_pending: bool,
    pub directory: bool,
}

#[napi(object)]
pub struct WindowsSecurityObservation {
    pub descriptor_control: u32,
    pub dacl_present: bool,
    pub dacl_null: bool,
    pub dacl_defaulted: bool,
    pub dacl_bytes: Buffer,
    pub owner_sid: String,
    pub owner_defaulted: bool,
    pub group_sid: String,
    pub group_defaulted: bool,
    pub current_user_sid: String,
}

#[napi(object)]
pub struct WindowsPathInspection {
    pub canonical_path: String,
    pub kind: String,
    pub volume: WindowsVolumeObservation,
    pub object: WindowsObjectObservation,
    pub security: WindowsSecurityObservation,
    pub ancestry_reparse_free: bool,
}

#[napi(object)]
pub struct WindowsPrivateDirectoryCreationReceipt {
    pub parent_before: WindowsPathInspection,
    pub created: WindowsPathInspection,
    pub parent_after: WindowsPathInspection,
}

#[napi(object)]
pub struct WindowsStableReadReceipt {
    pub bytes: Buffer,
    pub byte_count: String,
    pub before: WindowsObjectObservation,
    pub after: WindowsObjectObservation,
}

pub struct StableReadData {
    pub bytes: Vec<u8>,
    pub before: WindowsObjectObservation,
    pub after: WindowsObjectObservation,
}

#[napi(js_name = "getNativeWindowsInfo")]
pub fn get_native_windows_info() -> NativeWindowsInfo {
    NativeWindowsInfo {
        contract_version: NATIVE_CONTRACT_VERSION,
        package_version: env!("CARGO_PKG_VERSION").to_owned(),
        target: "win32-x64-msvc".to_owned(),
        max_stable_read_bytes: MAX_STABLE_READ_BYTES,
    }
}

#[napi(js_name = "inspectWindowsPath")]
pub fn inspect_windows_path(env: Env, path: String) -> Result<WindowsPathInspection> {
    into_napi(env, platform::inspect_windows_path(&path))
}

#[napi(js_name = "createWindowsPrivateDirectory")]
pub fn create_windows_private_directory(
    env: Env,
    parent_path: String,
    final_component: Utf16String,
) -> Result<WindowsPrivateDirectoryCreationReceipt> {
    let component = component::validate_final_component(&final_component);
    into_napi(
        env,
        component.and_then(|component| {
            platform::create_windows_private_directory(&parent_path, &component)
        }),
    )
}

pub struct StableReadTask {
    path: String,
    max_bytes: u32,
}

impl Task for StableReadTask {
    type Output = StableReadData;
    type JsValue = WindowsStableReadReceipt;

    fn compute(&mut self) -> Result<Self::Output> {
        into_async_napi(platform::read_windows_file_stable(
            &self.path,
            self.max_bytes,
        ))
    }

    fn resolve(&mut self, _env: Env, data: Self::Output) -> Result<Self::JsValue> {
        Ok(WindowsStableReadReceipt {
            byte_count: format!("{:016x}", data.bytes.len()),
            bytes: Buffer::from(data.bytes),
            before: data.before,
            after: data.after,
        })
    }
}

#[napi(js_name = "readWindowsFileStable")]
pub fn read_windows_file_stable(path: String, max_bytes: u32) -> Result<AsyncTask<StableReadTask>> {
    if max_bytes > MAX_STABLE_READ_BYTES {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "ERR_WIN32_READ_LIMIT: maxBytes exceeds the Bazframe native limit of {MAX_STABLE_READ_BYTES} bytes"
            ),
        ));
    }
    Ok(AsyncTask::new(StableReadTask { path, max_bytes }))
}
