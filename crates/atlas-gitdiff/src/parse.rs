//! Minimal unified-diff parser: turns `git diff` text into hunks of classified
//! lines. Just enough to feed the side-by-side engine — header lines (diff
//! --git, index, ---/+++, rename/mode) are skipped; binary diffs are flagged.

use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawKind {
    Context,
    Minus,
    Plus,
}

#[derive(Debug, Clone)]
pub struct RawLine {
    pub kind: RawKind,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct Hunk {
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<RawLine>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedDiff {
    pub is_binary: bool,
    pub hunks: Vec<Hunk>,
}

fn hunk_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap())
}

/// Parse `git diff` (single- or multi-file) unified output into hunks. Lines
/// before the first `@@` (file headers) are ignored.
///
/// A hunk ends when the line counts in its `@@` header are used up, not at the
/// next `@@`: otherwise the next file's `---`/`+++` headers would read as a
/// removed and an added line of the previous hunk.
pub fn parse_unified(diff: &str) -> ParsedDiff {
    let mut out = ParsedDiff::default();
    let mut cur: Option<Hunk> = None;
    // Lines still owed to the open hunk: (old side, new side).
    let mut left = (0u32, 0u32);

    for line in diff.lines() {
        // A new file always closes the open hunk, even if its header's counts
        // were wrong.
        if line.starts_with("diff --git ") {
            if let Some(h) = cur.take() {
                out.hunks.push(h);
            }
            continue;
        }
        if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            out.is_binary = true;
            continue;
        }
        if let Some(caps) = hunk_header_re().captures(line) {
            if let Some(h) = cur.take() {
                out.hunks.push(h);
            }
            let old_start = caps[1].parse().unwrap_or(0);
            let new_start = caps[3].parse().unwrap_or(0);
            // An omitted count means one line (`-40` is `-40,1`).
            let count = |i: usize| caps.get(i).map_or(Some(1), |m| m.as_str().parse().ok());
            left = (count(2).unwrap_or(0), count(4).unwrap_or(0));
            cur = Some(Hunk {
                old_start,
                new_start,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = cur.as_mut() else {
            // Still in the file header preamble (diff --git / index / --- / +++ /
            // rename / new file …) — nothing to collect until the first hunk.
            continue;
        };
        // "\ No newline at end of file" markers carry no content.
        if line.starts_with('\\') {
            continue;
        }
        let (kind, rest) = match line.as_bytes().first() {
            Some(b'+') => (RawKind::Plus, &line[1..]),
            Some(b'-') => (RawKind::Minus, &line[1..]),
            Some(b' ') => (RawKind::Context, &line[1..]),
            // A truly empty line inside a hunk = a blank context line.
            None => (RawKind::Context, ""),
            _ => continue,
        };
        hunk.lines.push(RawLine {
            kind,
            text: rest.to_string(),
        });
        match kind {
            RawKind::Context => left = (left.0.saturating_sub(1), left.1.saturating_sub(1)),
            RawKind::Minus => left.0 = left.0.saturating_sub(1),
            RawKind::Plus => left.1 = left.1.saturating_sub(1),
        }
        if left == (0, 0) {
            if let Some(h) = cur.take() {
                out.hunks.push(h);
            }
        }
    }
    if let Some(h) = cur.take() {
        out.hunks.push(h);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(h: &Hunk) -> Vec<(RawKind, &str)> {
        h.lines.iter().map(|l| (l.kind, l.text.as_str())).collect()
    }

    use RawKind::{Context as C, Minus as M, Plus as P};

    #[test]
    fn an_empty_diff_has_no_hunks() {
        for diff in ["", "\n", "diff --git a/x b/x\nindex 1..2 100644\n"] {
            let parsed = parse_unified(diff);
            assert!(parsed.hunks.is_empty(), "{diff:?}");
            assert!(!parsed.is_binary);
        }
    }

    #[test]
    fn headers_are_skipped_and_lines_classified() {
        let parsed = parse_unified(
            "diff --git a/f.rs b/f.rs\n\
             index 111..222 100644\n\
             --- a/f.rs\n\
             +++ b/f.rs\n\
             @@ -10,3 +10,3 @@ fn context_after_the_header() {\n \
             keep\n\
             -old\n\
             +new\n",
        );
        assert_eq!(parsed.hunks.len(), 1);
        let h = &parsed.hunks[0];
        assert_eq!((h.old_start, h.new_start), (10, 10));
        assert_eq!(kinds(h), [(C, "keep"), (M, "old"), (P, "new")]);
    }

    #[test]
    fn several_hunks_keep_their_own_starts() {
        let parsed = parse_unified("@@ -1,2 +1,2 @@\n-a\n+b\n@@ -40 +41,2 @@\n x\n+y\n");
        assert_eq!(parsed.hunks.len(), 2);
        assert_eq!(
            (parsed.hunks[0].old_start, parsed.hunks[0].new_start),
            (1, 1)
        );
        // A single-line range omits its count (`-40`, not `-40,1`).
        assert_eq!(
            (parsed.hunks[1].old_start, parsed.hunks[1].new_start),
            (40, 41)
        );
        assert_eq!(kinds(&parsed.hunks[1]), [(C, "x"), (P, "y")]);
    }

    #[test]
    fn the_no_newline_marker_carries_no_content() {
        let parsed = parse_unified(
            "@@ -1 +1 @@\n-last\n\\ No newline at end of file\n+last\n\\ No newline at end of file\n",
        );
        assert_eq!(kinds(&parsed.hunks[0]), [(M, "last"), (P, "last")]);
    }

    #[test]
    fn a_blank_line_inside_a_hunk_is_blank_context() {
        // Some tools strip the single leading space from an empty context line.
        let parsed = parse_unified("@@ -1,3 +1,3 @@\n a\n\n b\n");
        assert_eq!(kinds(&parsed.hunks[0]), [(C, "a"), (C, ""), (C, "b")]);
    }

    #[test]
    fn content_that_looks_like_a_header_is_still_content() {
        // A removed `-- sql comment` and an added `++counter` inside a hunk are
        // lines, not file headers.
        let parsed = parse_unified("@@ -1 +1 @@\n--- sql comment\n+++counter;\n");
        assert_eq!(
            kinds(&parsed.hunks[0]),
            [(M, "-- sql comment"), (P, "++counter;")]
        );
    }

    #[test]
    fn crlf_line_endings_are_stripped_with_the_newline() {
        // `str::lines` treats `\r\n` as one terminator, so a CRLF file's lines
        // arrive without the `\r` — and a CRLF-only change renders as a
        // removed and an added line with identical text.
        let parsed = parse_unified("@@ -1 +1 @@\r\n-a\r\n+a\n");
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(kinds(&parsed.hunks[0]), [(M, "a"), (P, "a")]);
    }

    #[test]
    fn binary_diffs_are_flagged_in_both_forms() {
        let summary = parse_unified(
            "diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n",
        );
        assert!(summary.is_binary);
        assert!(summary.hunks.is_empty());

        let patch = parse_unified(
            "diff --git a/x.bin b/x.bin\nindex 1..2 100644\nGIT binary patch\nliteral 3\nKcmZ?\n\nliteral 0\nHcmV?d00001\n\n",
        );
        assert!(patch.is_binary);
        assert!(
            patch.hunks.is_empty(),
            "the base85 payload is not diff content"
        );
    }

    #[test]
    fn a_pure_rename_has_no_hunks() {
        let parsed = parse_unified(
            "diff --git a/old.rs b/new.rs\n\
             similarity index 100%\n\
             rename from old.rs\n\
             rename to new.rs\n",
        );
        assert!(parsed.hunks.is_empty());
        assert!(!parsed.is_binary);
    }

    #[test]
    fn a_rename_with_edits_parses_its_hunk() {
        let parsed = parse_unified(
            "diff --git a/old.rs b/new.rs\n\
             similarity index 80%\n\
             rename from old.rs\n\
             rename to new.rs\n\
             index 1..2 100644\n\
             --- a/old.rs\n\
             +++ b/new.rs\n\
             @@ -1,2 +1,2 @@\n \
             same\n\
             -before\n\
             +after\n",
        );
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(
            kinds(&parsed.hunks[0]),
            [(C, "same"), (M, "before"), (P, "after")]
        );
    }

    #[test]
    fn new_and_deleted_files_parse_against_dev_null() {
        let added = parse_unified(
            "diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+hi\n",
        );
        assert_eq!((added.hunks[0].old_start, added.hunks[0].new_start), (0, 1));
        assert_eq!(kinds(&added.hunks[0]), [(P, "hi")]);

        let deleted = parse_unified(
            "diff --git a/d b/d\ndeleted file mode 100644\n--- a/d\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
        );
        assert_eq!(
            (deleted.hunks[0].old_start, deleted.hunks[0].new_start),
            (1, 0)
        );
        assert_eq!(kinds(&deleted.hunks[0]), [(M, "bye")]);
    }

    #[test]
    fn a_mode_only_change_has_no_hunks() {
        let parsed = parse_unified("diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n");
        assert!(parsed.hunks.is_empty());
    }

    #[test]
    fn a_combined_merge_diff_is_not_parsed() {
        // `git diff` during a conflicted merge emits combined hunks
        // (`@@@ -a -b +c @@@`, two-column line prefixes). The header regex
        // expects one old range, so nothing is collected — an empty result
        // rather than lines misclassified by their first column.
        let parsed = parse_unified("@@@ -1,2 -1,2 +1,3 @@@\n  a\n++b\n");
        assert!(parsed.hunks.is_empty());
    }

    /// The module docs promise multi-file input, but the parser has no notion
    /// of a hunk's length: once a hunk is open, the next file's `--- a/…` and
    /// `+++ b/…` headers read as a removed and an added line of the previous
    /// file. Ignored until the parser counts hunk lines (or resets on
    /// `diff --git`) — run with `--ignored` to see it fail.
    #[test]
    fn a_multi_file_diff_does_not_leak_headers_into_the_previous_hunk() {
        let parsed = parse_unified(
            "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n\
             diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-p\n+q\n",
        );
        assert_eq!(parsed.hunks.len(), 2);
        assert_eq!(kinds(&parsed.hunks[0]), [(M, "x"), (P, "y")]);
    }
}
