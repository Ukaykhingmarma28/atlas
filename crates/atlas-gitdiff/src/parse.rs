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
    // `@@ -a,b +c,d @@`, or a combined diff's `@@@ -a,b -c,d +e,f @@@` (one
    // more `@` and one more old range per extra parent).
    RE.get_or_init(|| {
        Regex::new(r"^(@@+) -(\d+)(?:,(\d+))?(?: -\d+(?:,\d+)?)* \+(\d+)(?:,(\d+))? @@+").unwrap()
    })
}

/// Parse `git diff` (single- or multi-file) unified output into hunks. Lines
/// before the first `@@` (file headers) are ignored.
///
/// A hunk ends when the line counts in its `@@` header are used up, not at the
/// next `@@`: otherwise the next file's `---`/`+++` headers would read as a
/// removed and an added line of the previous hunk.
///
/// Lines are split on `\n` alone, so a CRLF file's `\r` stays in the line's
/// text: a change that only converts line endings keeps its one real
/// difference.
///
/// A combined diff (`diff --cc`, what `git diff` prints for a conflicted
/// merge) is read against its FIRST parent — the same two-sided view `git
/// diff` gives of an ordinary change. Its hunks carry one prefix column per
/// parent; only the first decides the line's kind, and a line that exists
/// only in another parent is dropped.
pub fn parse_unified(diff: &str) -> ParsedDiff {
    let mut out = ParsedDiff::default();
    let mut cur: Option<Hunk> = None;
    // Lines still owed to the open hunk: (old side, new side).
    let mut left = (0u32, 0u32);
    // Prefix columns per line: 1 for a plain diff, one per parent for combined.
    let mut columns = 1usize;

    for raw in diff.split_terminator('\n') {
        // Header and marker lines are recognised without a trailing `\r`, so
        // a diff whose own lines were converted to CRLF still parses.
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        // A new file always closes the open hunk, even if its header's counts
        // were wrong.
        if line.starts_with("diff --git ")
            || line.starts_with("diff --cc ")
            || line.starts_with("diff --combined ")
        {
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
            columns = caps[1].len() - 1;
            let old_start = caps[2].parse().unwrap_or(0);
            let new_start = caps[4].parse().unwrap_or(0);
            // An omitted count means one line (`-40` is `-40,1`).
            let count = |i: usize| caps.get(i).map_or(Some(1), |m| m.as_str().parse().ok());
            left = (count(3).unwrap_or(0), count(5).unwrap_or(0));
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
        let Some((kind, rest)) = classify(raw, columns) else {
            continue;
        };
        if let Some(kind) = kind {
            hunk.lines.push(RawLine {
                kind,
                text: rest.to_string(),
            });
            match kind {
                RawKind::Context => left = (left.0.saturating_sub(1), left.1.saturating_sub(1)),
                RawKind::Minus => left.0 = left.0.saturating_sub(1),
                RawKind::Plus => left.1 = left.1.saturating_sub(1),
            }
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

/// Split a hunk line into its kind and text. `None`: not a hunk line at all.
/// `Some((None, _))`: a combined-diff line absent from both the first parent
/// and the result, which the two-sided view has no place for.
fn classify(line: &str, columns: usize) -> Option<(Option<RawKind>, &str)> {
    // A truly empty line inside a hunk = a blank context line (some tools strip
    // the leading space from an empty context line).
    if line.is_empty() || line == "\r" {
        return Some((Some(RawKind::Context), ""));
    }
    let prefix = line.as_bytes().get(..columns)?;
    if !prefix.iter().all(|b| matches!(b, b' ' | b'+' | b'-')) {
        return None;
    }
    let rest = &line[columns..];
    let kind = match prefix[0] {
        b'+' => Some(RawKind::Plus),
        b'-' => Some(RawKind::Minus),
        // In the first parent and the result, unless another parent's column
        // says the result doesn't have it (then it's in neither).
        _ if prefix.contains(&b'-') => None,
        _ => Some(RawKind::Context),
    };
    Some((kind, rest))
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
    fn a_crlf_only_change_keeps_its_carriage_return() {
        // git's own output is LF-terminated; a `\r` before the `\n` is part of
        // the file's line. Dropping it would turn a line-ending change into a
        // removed and an added line with identical text.
        let parsed = parse_unified("@@ -1 +1 @@\n-a\r\n+a\n");
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(kinds(&parsed.hunks[0]), [(M, "a\r"), (P, "a")]);
    }

    #[test]
    fn a_diff_converted_to_crlf_still_parses() {
        let parsed = parse_unified(
            "diff --git a/f b/f\r\n--- a/f\r\n+++ b/f\r\n@@ -1,2 +1,2 @@\r\n keep\r\n-old\r\n+new\r\n\\ No newline at end of file\r\n",
        );
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(
            kinds(&parsed.hunks[0]),
            [(C, "keep\r"), (M, "old\r"), (P, "new\r")]
        );
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
    fn a_combined_merge_diff_is_read_against_its_first_parent() {
        // `git diff` during a conflicted merge: two prefix columns, one per
        // parent. A `-` in a column: that parent has the line, the result
        // doesn't; a `+`: the result has it, that parent doesn't. So ` -` is
        // in parent 2 only and neither side shows it; `- ` is removed from
        // parent 1; `++` and `+ ` are added relative to parent 1; ` +` is in
        // parent 1 and the result (context).
        let parsed = parse_unified(
            "diff --cc f.rs\n\
             index 1,2..3\n\
             --- a/f.rs\n\
             +++ b/f.rs\n\
             @@@ -1,3 -1,3 +1,4 @@@\n  \
             same\n \
             -theirs\n\
             - ours\n\
             ++merged\n \
             +from_ours\n\
             + from_theirs\n\
             diff --cc g.rs\n\
             @@@ -5 -5 +5 @@@\n\
             --gone\n\
             ++here\n",
        );
        assert_eq!(parsed.hunks.len(), 2);
        let h = &parsed.hunks[0];
        assert_eq!((h.old_start, h.new_start), (1, 1));
        assert_eq!(
            kinds(h),
            [
                (C, "same"),
                (M, "ours"),
                (P, "merged"),
                (C, "from_ours"),
                (P, "from_theirs"),
            ]
        );
        assert_eq!(
            kinds(&parsed.hunks[1]),
            [(M, "gone"), (P, "here")]
        );
    }

    /// Once a hunk is open, the next file's `--- a/…` and `+++ b/…` headers
    /// must not read as a removed and an added line of the previous file.
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
