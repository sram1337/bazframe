use crate::{NativeResult, native_error};

const MAX_COMPONENT_UTF16_UNITS: usize = 255;

pub(crate) fn validate_final_component(units: &[u16]) -> NativeResult<String> {
    if units.is_empty() || units.len() > MAX_COMPONENT_UTF16_UNITS {
        return Err(invalid_component());
    }
    let value = String::from_utf16(units).map_err(|_| invalid_component())?;
    if value == "."
        || value == ".."
        || value.chars().any(|character| {
            matches!(
                character,
                '\0'..='\u{1f}' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
        || value.ends_with([' ', '.'])
        || is_reserved_dos_name(&value)
    {
        return Err(invalid_component());
    }
    Ok(value)
}

fn is_reserved_dos_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || reserved_numbered_name(&stem, "COM")
        || reserved_numbered_name(&stem, "LPT")
}

fn reserved_numbered_name(value: &str, prefix: &str) -> bool {
    let Some(suffix) = value.strip_prefix(prefix) else {
        return false;
    };
    matches!(
        suffix,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
    )
}

fn invalid_component() -> napi::Error<String> {
    native_error(
        "ERR_WIN32_INVALID_PATH",
        "Windows final path component is invalid or reserved",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[test]
    fn accepts_one_normal_component() {
        assert_eq!(
            validate_final_component(&units("private-数据")).unwrap(),
            "private-数据"
        );
    }

    #[test]
    fn rejects_aliases_separators_controls_and_trailing_equivalents() {
        for value in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "a:b",
            "a\0b",
            "a\u{1f}b",
            "name.",
            "name ",
            "CON",
            "con.txt",
            "COM1",
            "com¹.log",
            "LPT9",
            "NUL.bin",
        ] {
            assert!(
                validate_final_component(&units(value)).is_err(),
                "{value:?}"
            );
        }
    }

    #[test]
    fn rejects_unpaired_utf16_and_overlong_components() {
        assert!(validate_final_component(&[0xd800]).is_err());
        assert!(validate_final_component(&vec![b'a' as u16; 256]).is_err());
        assert!(validate_final_component(&vec![b'a' as u16; 255]).is_ok());
    }
}
