//! Reading an icon theme out of a `.vsix`.
//!
//! A `.vsix` is a plain zip with the extension's own tree under `extension/`.
//! Atlas unpacks that subtree and nothing else: the compiled extension host,
//! the localisation bundles and the marketplace metadata describe a VS Code
//! extension Atlas never runs, and unpacking them would mean shipping a user's
//! machine a few hundred KB of JavaScript it can only be confused by.
//!
//! Containment is the other reason this is not `ZipArchive::extract`. Every
//! entry is resolved through `enclosed_name()`, which refuses absolute paths
//! and `..` traversal, and the result is joined onto the destination — so a
//! hostile archive cannot write outside the icon-theme directory even though
//! the destination is under the user's config dir.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::IconThemeError;

/// Ceilings on what an archive may claim, so a malformed or hostile one fails
/// fast instead of filling the disk. Material — by a wide margin the largest
/// icon theme published — is 1,278 entries and 1.9 MB unpacked.
const MAX_ENTRIES: usize = 20_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;

/// The prefix every file in a `.vsix` extension payload carries.
const PAYLOAD_PREFIX: &str = "extension/";

/// Unpack the `extension/` subtree of `archive` into `destination`, stripping
/// the prefix. Returns the number of files written.
pub fn unpack_extension(archive_bytes: &[u8], destination: &Path) -> Result<usize, IconThemeError> {
    let reader = std::io::Cursor::new(archive_bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|source| IconThemeError::Vsix {
        message: format!("not a readable .vsix: {source}"),
    })?;
    if archive.len() > MAX_ENTRIES {
        return Err(IconThemeError::Vsix {
            message: format!("{} entries, past the {MAX_ENTRIES} accepted", archive.len()),
        });
    }

    fs::create_dir_all(destination)
        .map_err(|source| IconThemeError::Io { path: destination.to_path_buf(), source })?;

    let mut written = 0usize;
    let mut budget = MAX_UNCOMPRESSED_BYTES;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|source| IconThemeError::Vsix {
            message: format!("reading entry {index}: {source}"),
        })?;
        if entry.is_dir() {
            continue;
        }
        // `enclosed_name` is the containment check: it returns `None` for an
        // absolute path, a drive letter or any `..` that escapes the root.
        let Some(name) = entry.enclosed_name() else {
            return Err(IconThemeError::Vsix {
                message: format!("entry {index} has a path that escapes the archive root"),
            });
        };
        let Some(relative) = strip_payload_prefix(&name) else {
            continue;
        };
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|source| IconThemeError::Io { path: parent.to_path_buf(), source })?;
        }
        let mut bytes = Vec::new();
        // Read at most one byte past what is left, so an entry whose header
        // lies about its size cannot inflate unbounded before the check below.
        (&mut entry)
            .take(budget + 1)
            .read_to_end(&mut bytes)
            .map_err(|source| IconThemeError::Io { path: target.clone(), source })?;
        budget = budget.checked_sub(bytes.len() as u64).ok_or_else(|| IconThemeError::Vsix {
            message: format!("expands past the {MAX_UNCOMPRESSED_BYTES} byte ceiling"),
        })?;
        fs::write(&target, &bytes)
            .map_err(|source| IconThemeError::Io { path: target.clone(), source })?;
        written += 1;
    }
    if written == 0 {
        return Err(IconThemeError::Vsix {
            message: format!("no `{PAYLOAD_PREFIX}` payload — is this a .vsix?"),
        });
    }
    Ok(written)
}

/// `extension/dist/x.json` -> `dist/x.json`; anything outside the payload is
/// dropped (`extension.vsixmanifest`, `[Content_Types].xml`).
fn strip_payload_prefix(name: &Path) -> Option<PathBuf> {
    let as_str = name.to_str()?.replace('\\', "/");
    as_str.strip_prefix(PAYLOAD_PREFIX).filter(|rest| !rest.is_empty()).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            for (name, body) in entries {
                writer
                    .start_file(*name, zip::write::SimpleFileOptions::default())
                    .expect("start_file");
                writer.write_all(body.as_bytes()).expect("write");
            }
            writer.finish().expect("finish");
        }
        buffer
    }

    #[test]
    fn unpacks_the_extension_subtree_and_strips_the_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let archive = build_zip(&[
            ("extension.vsixmanifest", "<xml/>"),
            ("[Content_Types].xml", "<xml/>"),
            ("extension/package.json", "{}"),
            ("extension/icons/a.svg", "<svg/>"),
        ]);
        let written = unpack_extension(&archive, dir.path()).expect("unpacks");
        assert_eq!(written, 2, "only the payload is written");
        assert!(dir.path().join("package.json").is_file());
        assert!(dir.path().join("icons/a.svg").is_file());
        assert!(!dir.path().join("extension.vsixmanifest").exists());
    }

    #[test]
    fn refuses_an_archive_with_no_payload() {
        let dir = tempfile::tempdir().expect("tempdir");
        let archive = build_zip(&[("readme.txt", "hi")]);
        let error = unpack_extension(&archive, dir.path()).unwrap_err();
        assert!(error.to_string().contains("no `extension/` payload"), "{error}");
    }

    #[test]
    fn refuses_something_that_is_not_a_zip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let error = unpack_extension(b"not a zip at all", dir.path()).unwrap_err();
        assert!(error.to_string().contains("not a readable .vsix"), "{error}");
    }

    #[test]
    fn an_archive_past_the_expansion_budget_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            writer
                .start_file("extension/big.bin", zip::write::SimpleFileOptions::default())
                .expect("start_file");
            let chunk = vec![0u8; 1024 * 1024];
            for _ in 0..=(MAX_UNCOMPRESSED_BYTES / chunk.len() as u64) {
                writer.write_all(&chunk).expect("write");
            }
            writer.finish().expect("finish");
        }
        let error = unpack_extension(&buffer, dir.path()).unwrap_err();
        assert!(error.to_string().contains("ceiling"), "{error}");
    }

    #[test]
    fn a_traversal_entry_never_escapes_the_destination() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).expect("mkdir");
        let root = dir.path().join("theme");
        let archive = build_zip(&[
            ("extension/../../pwned.svg", "<svg/>"),
            ("extension/icons/a.svg", "<svg/>"),
        ]);
        // Either the entry is refused outright or it is contained; both are
        // acceptable, writing outside `root` is not.
        let _ = unpack_extension(&archive, &root);
        assert!(!dir.path().join("pwned.svg").exists());
        assert!(!outside.join("pwned.svg").exists());
    }
}
