// Error-only diagnosis from observations already obtained by the authoritative caller.
// These helpers never decide admission and never format observed values.
#[cfg(test)]
use crate::WindowsSecurityObservation;

use crate::{NativeResult, WindowsObjectObservation, WindowsPathInspection, native_error};

pub(crate) fn read_changed<T>(
    site: &'static str,
    directory: bool,
    role: &'static str,
    fields: Vec<&'static str>,
) -> NativeResult<T> {
    Err(native_error(
        "ERR_WIN32_READ_CHANGED",
        format!(
            "read-change|{site}|{}|{role}|{}",
            if directory {
                "directory"
            } else {
                "regular-file"
            },
            fields.join(",")
        ),
    ))
}

pub(crate) fn prefix_role(index: usize, last: usize) -> &'static str {
    if index == last {
        "final"
    } else if index == 0 {
        "drive-root"
    } else {
        "ancestor"
    }
}

pub(crate) fn stable_fields(
    a: &WindowsObjectObservation,
    b: &WindowsObjectObservation,
) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if a.volume_identity != b.volume_identity {
        fields.push("object.volumeIdentity");
    }
    if a.file_id != b.file_id {
        fields.push("object.fileId");
    }
    if a.size != b.size {
        fields.push("object.size");
    }
    if a.allocation_size != b.allocation_size {
        fields.push("object.allocationSize");
    }
    if a.number_of_links != b.number_of_links {
        fields.push("object.numberOfLinks");
    }
    if a.creation_time != b.creation_time {
        fields.push("object.creationTime");
    }
    if a.last_write_time != b.last_write_time {
        fields.push("object.lastWriteTime");
    }
    if a.change_time != b.change_time {
        fields.push("object.changeTime");
    }
    if a.attributes != b.attributes {
        fields.push("object.attributes");
    }
    if a.reparse_tag != b.reparse_tag {
        fields.push("object.reparseTag");
    }
    if a.delete_pending != b.delete_pending {
        fields.push("object.deletePending");
    }
    if a.directory != b.directory {
        fields.push("object.directory");
    }
    fields
}

// Diagnosis of the admission comparison only, never of enumeration or reads.
pub(crate) fn admission_fields(
    a: &WindowsObjectObservation,
    b: &WindowsObjectObservation,
) -> Vec<&'static str> {
    let mut fields = stable_fields(a, b);
    if a.directory && b.directory {
        fields.retain(|field| !matches!(*field, "object.lastWriteTime" | "object.changeTime"));
    }
    fields
}

pub(crate) fn stable_read_fields(
    before: &WindowsObjectObservation,
    after: &WindowsObjectObservation,
    expected: u64,
    byte_count: u64,
) -> Vec<&'static str> {
    let mut fields = stable_fields(before, after);
    if byte_count != expected {
        fields.push("byteCountExpected");
    }
    // snapshot emits fixed-width nonnegative hex; no additional fallible parse.
    if after.size != format!("{byte_count:016x}") {
        fields.push("afterSizeByteCount");
    }
    fields
}

#[cfg(test)]
pub(crate) fn security_fields(
    a: &WindowsSecurityObservation,
    b: &WindowsSecurityObservation,
) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if a.descriptor_control != b.descriptor_control {
        fields.push("security.descriptorControl");
    }
    if a.dacl_present != b.dacl_present {
        fields.push("security.daclPresent");
    }
    if a.dacl_null != b.dacl_null {
        fields.push("security.daclNull");
    }
    if a.dacl_defaulted != b.dacl_defaulted {
        fields.push("security.daclDefaulted");
    }
    if a.dacl_bytes.as_ref() != b.dacl_bytes.as_ref() {
        fields.push("security.daclBytes");
    }
    if a.owner_sid != b.owner_sid {
        fields.push("security.ownerSid");
    }
    if a.owner_defaulted != b.owner_defaulted {
        fields.push("security.ownerDefaulted");
    }
    if a.group_sid != b.group_sid {
        fields.push("security.groupSid");
    }
    if a.group_defaulted != b.group_defaulted {
        fields.push("security.groupDefaulted");
    }
    if a.current_user_sid != b.current_user_sid {
        fields.push("security.currentUserSid");
    }
    fields
}

pub(crate) fn directory_fields(
    a: &WindowsPathInspection,
    b: &WindowsPathInspection,
) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if a.canonical_path != b.canonical_path {
        fields.push("canonicalPath");
    }
    if a.kind != "directory" || b.kind != "directory" {
        fields.push("kindDirectory");
    }
    if a.volume.identity != b.volume.identity {
        fields.push("volume.identity");
    }
    if a.object.volume_identity != b.object.volume_identity {
        fields.push("object.volumeIdentity");
    }
    if a.object.file_id != b.object.file_id {
        fields.push("object.fileId");
    }
    if a.object.reparse_tag != 0 || b.object.reparse_tag != 0 {
        fields.push("reparseTagZero");
    }
    if a.object.delete_pending || b.object.delete_pending {
        fields.push("notDeletePending");
    }
    if !a.object.directory || !b.object.directory {
        fields.push("objectDirectory");
    }
    fields
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::WindowsVolumeObservation;

    pub(crate) fn object() -> WindowsObjectObservation {
        WindowsObjectObservation {
            volume_identity: "PRIVATE".into(),
            file_id: "PRIVATE".into(),
            size: "0000000000000003".into(),
            allocation_size: "PRIVATE".into(),
            number_of_links: "PRIVATE".into(),
            creation_time: "PRIVATE".into(),
            last_access_time: "PRIVATE".into(),
            last_write_time: "PRIVATE".into(),
            change_time: "PRIVATE".into(),
            attributes: 0,
            reparse_tag: 0,
            delete_pending: false,
            directory: true,
        }
    }
    pub(crate) fn security() -> WindowsSecurityObservation {
        WindowsSecurityObservation {
            descriptor_control: 0,
            dacl_present: true,
            dacl_null: false,
            dacl_defaulted: false,
            dacl_bytes: vec![1, 2].into(),
            owner_sid: "PRIVATE".into(),
            owner_defaulted: false,
            group_sid: "PRIVATE".into(),
            group_defaulted: false,
            current_user_sid: "PRIVATE".into(),
        }
    }
    pub(crate) fn inspection() -> WindowsPathInspection {
        WindowsPathInspection {
            canonical_path: "PRIVATE".into(),
            kind: "directory".into(),
            volume: WindowsVolumeObservation {
                identity: "PRIVATE".into(),
                filesystem_name: "NTFS".into(),
                drive_type: "fixed".into(),
                canonical_volume_guid_path: "PRIVATE".into(),
                remote_device: false,
            },
            object: object(),
            ancestry_reparse_free: true,
        }
    }

    #[test]
    fn stable_diagnostic_fields_are_exact_and_do_not_include_access_time() {
        let a = object();
        assert!(stable_fields(&a, &object()).is_empty());
        macro_rules! changed {
            ($field:ident, $value:expr, $name:literal) => {{
                let mut b = object();
                b.$field = $value;
                assert_eq!(stable_fields(&a, &b), vec![$name]);
                let exempt = matches!($name, "object.lastWriteTime" | "object.changeTime");
                assert_eq!(
                    admission_fields(&a, &b),
                    if exempt { vec![] } else { vec![$name] }
                );
                let mut file_a = a.clone();
                file_a.directory = false;
                let mut file_b = b.clone();
                file_b.directory = false;
                assert_eq!(
                    admission_fields(&file_a, &file_b),
                    stable_fields(&file_a, &file_b)
                );
                assert_eq!(admission_fields(&a, &file_b), stable_fields(&a, &file_b));
                assert_eq!(admission_fields(&file_b, &a), stable_fields(&file_b, &a));
            }};
        }
        changed!(volume_identity, "OTHER".into(), "object.volumeIdentity");
        changed!(file_id, "OTHER".into(), "object.fileId");
        changed!(size, "OTHER".into(), "object.size");
        changed!(allocation_size, "OTHER".into(), "object.allocationSize");
        changed!(number_of_links, "OTHER".into(), "object.numberOfLinks");
        changed!(creation_time, "OTHER".into(), "object.creationTime");
        changed!(last_write_time, "OTHER".into(), "object.lastWriteTime");
        changed!(change_time, "OTHER".into(), "object.changeTime");
        changed!(attributes, 1, "object.attributes");
        changed!(reparse_tag, 1, "object.reparseTag");
        changed!(delete_pending, true, "object.deletePending");
        changed!(directory, false, "object.directory");
        let mut access = object();
        access.last_access_time = "OTHER".into();
        assert!(stable_fields(&a, &access).is_empty());
        assert!(admission_fields(&a, &access).is_empty());
    }

    #[test]
    fn stable_read_count_predicates_are_separate_from_metadata_differences() {
        let a = object();
        assert!(stable_read_fields(&a, &a, 3, 3).is_empty());
        assert_eq!(
            stable_read_fields(&a, &a, 3, 2),
            vec!["byteCountExpected", "afterSizeByteCount"]
        );
        let mut b = object();
        b.size = "0000000000000004".into();
        assert_eq!(
            stable_read_fields(&a, &b, 3, 3),
            vec!["object.size", "afterSizeByteCount"]
        );
    }

    #[test]
    fn security_fields_report_names_only_and_all_compared_fields() {
        let a = security();
        assert!(security_fields(&a, &security()).is_empty());
        macro_rules! changed {
            ($field:ident, $value:expr, $name:literal) => {{
                let mut b = security();
                b.$field = $value;
                assert_eq!(security_fields(&a, &b), vec![$name]);
            }};
        }
        changed!(descriptor_control, 1, "security.descriptorControl");
        changed!(dacl_present, false, "security.daclPresent");
        changed!(dacl_null, true, "security.daclNull");
        changed!(dacl_defaulted, true, "security.daclDefaulted");
        changed!(dacl_bytes, vec![3].into(), "security.daclBytes");
        changed!(owner_sid, "OTHER".into(), "security.ownerSid");
        changed!(owner_defaulted, true, "security.ownerDefaulted");
        changed!(group_sid, "OTHER".into(), "security.groupSid");
        changed!(group_defaulted, true, "security.groupDefaulted");
        changed!(current_user_sid, "OTHER".into(), "security.currentUserSid");
    }

    #[test]
    fn directory_predicates_report_even_equal_but_invalid_inputs() {
        assert!(directory_fields(&inspection(), &inspection()).is_empty());
        let mut a = inspection();
        let mut b = inspection();
        a.kind = "regular-file".into();
        b.kind = "regular-file".into();
        a.object.reparse_tag = 1;
        b.object.reparse_tag = 1;
        a.object.delete_pending = true;
        b.object.delete_pending = true;
        a.object.directory = false;
        b.object.directory = false;
        assert_eq!(
            directory_fields(&a, &b),
            vec![
                "kindDirectory",
                "reparseTagZero",
                "notDeletePending",
                "objectDirectory"
            ]
        );
        let mut b = inspection();
        b.canonical_path = "OTHER".into();
        b.volume.identity = "OTHER".into();
        b.object.volume_identity = "OTHER".into();
        b.object.file_id = "OTHER".into();
        assert_eq!(
            directory_fields(&inspection(), &b),
            vec![
                "canonicalPath",
                "volume.identity",
                "object.volumeIdentity",
                "object.fileId",
            ]
        );
        let mut b = inspection();
        b.object.size = "OTHER".into();
        assert!(directory_fields(&inspection(), &b).is_empty());
    }

    #[test]
    fn fixed_origins_roles_and_growth_predicate_never_format_observed_values() {
        assert_eq!(prefix_role(0, 2), "drive-root");
        assert_eq!(prefix_role(1, 2), "ancestor");
        assert_eq!(prefix_role(2, 2), "final");
        assert_eq!(prefix_role(0, 0), "final");
        for site in [
            "inspect-opened-path",
            "rename-parent",
            "stable-read-growth",
            "stable-read-final",
            "reopened-prefix",
        ] {
            let error =
                read_changed::<()>(site, false, "none", vec!["growthProbeNonzero"]).unwrap_err();
            assert_eq!(error.status, "ERR_WIN32_READ_CHANGED");
            assert_eq!(
                error.reason,
                format!("read-change|{site}|regular-file|none|growthProbeNonzero")
            );
            assert!(!error.reason.contains("PRIVATE"));
        }
    }
}
