//! Background installer download shared by the platform updaters
//! (`updater_macos.rs` fetches a DMG, `updater_windows.rs` an MSI).
//!
//! A **parallel multi-connection range download** when the server supports it
//! (fast on throttled CDNs like GitHub/S3), falling back to a single stream,
//! writing to a `.part` file that is renamed into place only once complete.
//! Progress goes out as `atlas:update-progress` events.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

/// Concurrent connections used to fetch the installer. GitHub release assets
/// (S3) throttle per-connection, so a single stream can be very slow (~67 KB/s
/// seen for a 20 MB file); splitting into ranged segments saturates the link.
const DL_CONNECTIONS: u64 = 8;
/// Below this size, parallelism isn't worth the extra requests — stream it.
const DL_PARALLEL_MIN: u64 = 4 * 1024 * 1024;
/// Flush accumulated bytes to disk once a segment buffers this much.
const DL_WRITE_CHUNK: usize = 1024 * 1024;

pub(super) fn emit_progress(app: &AppHandle, version: &str, downloaded: u64, total: u64, phase: &str) {
    let _ = app.emit(
        "atlas:update-progress",
        serde_json::json!({ "version": version, "downloaded": downloaded, "total": total, "phase": phase }),
    );
}

/// Download `uri` to `part`, then atomically rename to `final_path`.
pub(super) async fn download_to(
    app: &AppHandle,
    uri: &str,
    part: &Path,
    final_path: &Path,
    version: &str,
) -> Result<(), String> {
    // One pooled client shared by every connection.
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Probe with a 1-byte ranged GET: a 206 + `Content-Range: …/<total>` tells us
    // the size AND that range requests work (so we can parallelize).
    let (total, ranges_ok) = probe_size(&client, uri).await;

    let _ = std::fs::remove_file(part);
    let mut ok = false;
    if ranges_ok && total >= DL_PARALLEL_MIN {
        match download_parallel(app, &client, uri, part, total, version).await {
            Ok(()) => ok = true,
            Err(e) => {
                // Range handling can misbehave behind some redirects/CDNs; degrade
                // to a correct (if slower) single stream rather than fail.
                tracing::warn!(target: "atlas::updater", "parallel download failed ({e}); falling back to single stream");
                let _ = std::fs::remove_file(part);
            }
        }
    }
    if !ok {
        download_stream(app, &client, uri, part, total, version).await?;
    }

    std::fs::rename(part, final_path).map_err(|e| {
        let _ = std::fs::remove_file(part);
        format!("finalize download: {e}")
    })
}

/// Returns `(total_bytes, range_supported)`. `total = 0` when unknown.
async fn probe_size(client: &reqwest::Client, uri: &str) -> (u64, bool) {
    let resp = client
        .get(uri)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await;
    let Ok(resp) = resp else { return (0, false) };
    if resp.status().as_u16() == 206 {
        // Content-Range: "bytes 0-0/12345"
        if let Some(total) = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.rsplit('/').next())
            .and_then(|s| s.trim().parse::<u64>().ok())
        {
            return (total, true);
        }
    }
    // Range not honored — fall back to the full length if advertised.
    (resp.content_length().unwrap_or(0), false)
}

/// Parallel range download: pre-size the file, fetch N byte-ranges concurrently,
/// each writing at its absolute offset. A ticker emits smooth progress.
async fn download_parallel(
    app: &AppHandle,
    client: &reqwest::Client,
    uri: &str,
    part: &Path,
    total: u64,
    version: &str,
) -> Result<(), String> {
    let file = std::fs::File::create(part).map_err(|e| format!("create part: {e}"))?;
    file.set_len(total).map_err(|e| format!("size part: {e}"))?;
    let file = Arc::new(file);

    let downloaded = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));

    // Progress ticker — decoupled from the writers so emits stay smooth and
    // aren't multiplied by the concurrent connections.
    let ticker = {
        let app = app.clone();
        let downloaded = downloaded.clone();
        let done = done.clone();
        let version = version.to_string();
        tauri::async_runtime::spawn(async move {
            loop {
                emit_progress(&app, &version, downloaded.load(Ordering::Relaxed), total, "downloading");
                if done.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
    };

    let seg = total.div_ceil(DL_CONNECTIONS);
    let mut handles = Vec::new();
    let mut start = 0u64;
    while start < total {
        let end = (start + seg).min(total) - 1;
        let client = client.clone();
        let uri = uri.to_string();
        let file = file.clone();
        let downloaded = downloaded.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            download_segment(&client, &uri, start, end, file, downloaded).await
        }));
        start += seg;
    }

    let mut err: Option<String> = None;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => err = Some(e),
            Err(e) => err = Some(format!("segment join: {e}")),
        }
    }
    done.store(true, Ordering::Relaxed);
    let _ = ticker.await;

    if let Some(e) = err {
        let _ = std::fs::remove_file(part);
        return Err(e);
    }
    emit_progress(app, version, total, total, "downloading");
    Ok(())
}

/// Fetch one byte-range and write it at its absolute offset (positional writes
/// are safe to run concurrently on non-overlapping ranges).
async fn download_segment(
    client: &reqwest::Client,
    uri: &str,
    start: u64,
    end: u64,
    file: Arc<std::fs::File>,
    downloaded: Arc<AtomicU64>,
) -> Result<(), String> {
    let resp = client
        .get(uri)
        .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|e| format!("segment request: {e}"))?;
    // Require a *partial* response — a 200 means the server ignored the Range and
    // sent the whole file, which would corrupt this offset-based writer.
    if resp.status().as_u16() != 206 {
        return Err(format!("segment download not ranged: HTTP {}", resp.status()));
    }

    let mut offset = start;
    let mut buf: Vec<u8> = Vec::with_capacity(DL_WRITE_CHUNK);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("segment chunk: {e}"))?;
        downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        buf.extend_from_slice(&chunk);
        if buf.len() >= DL_WRITE_CHUNK {
            let data = std::mem::take(&mut buf);
            let at = offset;
            offset += data.len() as u64;
            let f = file.clone();
            tokio::task::spawn_blocking(move || write_at(&f, &data, at))
                .await
                .map_err(|e| format!("write join: {e}"))?
                .map_err(|e| format!("write segment: {e}"))?;
        }
    }
    if !buf.is_empty() {
        let at = offset;
        tokio::task::spawn_blocking(move || write_at(&file, &buf, at))
            .await
            .map_err(|e| format!("write join: {e}"))?
            .map_err(|e| format!("write segment: {e}"))?;
    }
    Ok(())
}

/// Write all of `data` at absolute `offset` without touching a shared cursor,
/// so concurrent segments can share one file handle.
#[cfg(unix)]
fn write_at(file: &std::fs::File, data: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.write_all_at(data, offset)
}

/// Windows has no `write_all_at`; `seek_write` is a positional (overlapped)
/// write that may be short, so loop until the slice is drained.
#[cfg(windows)]
fn write_at(file: &std::fs::File, mut data: &[u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !data.is_empty() {
        match file.seek_write(data, offset) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "failed to write whole segment",
                ))
            }
            Ok(n) => {
                data = &data[n..];
                offset += n as u64;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Single-connection fallback (no range support / small file).
async fn download_stream(
    app: &AppHandle,
    client: &reqwest::Client,
    uri: &str,
    part: &Path,
    total: u64,
    version: &str,
) -> Result<(), String> {
    let resp = client.get(uri).send().await.map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = if total > 0 { total } else { resp.content_length().unwrap_or(0) };
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|e| format!("create part: {e}"))?;
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    emit_progress(app, version, 0, total, "downloading");
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| format!("write: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= DL_WRITE_CHUNK as u64 || (total > 0 && downloaded >= total) {
            last_emit = downloaded;
            emit_progress(app, version, downloaded, total, "downloading");
        }
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_at_places_every_segment_at_its_own_offset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("part");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(8).unwrap();
        // Out of order, as concurrent segments would land.
        write_at(&file, b"5678", 4).unwrap();
        write_at(&file, b"1234", 0).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"12345678");
    }
}
