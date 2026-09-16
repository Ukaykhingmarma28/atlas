//! A canned HTTP client, so no test in this crate touches the network.
//!
//! Zed's equivalent is `FakeHttpClient` (`http_client::FakeHttpClient`). Same
//! job: answer a known URL with known bytes, 404 everything else, and count
//! requests so a throttle can be asserted.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use atlas_agent_store::http::{HttpClient, HttpResponse};
use futures::future::BoxFuture;
use futures::StreamExt as _;

#[derive(Default)]
pub struct FakeHttp {
    responses: Mutex<HashMap<String, (u16, Vec<u8>)>>,
    requests: Mutex<Vec<String>>,
    /// Held before every response, so a test can keep a fetch in flight long
    /// enough for a second caller to arrive while it is still running.
    delay: Mutex<Option<std::time::Duration>>,
    /// Split every body into chunks of this size. A real server streams, and a
    /// single-chunk fake cannot tell a cumulative byte counter apart from a
    /// per-chunk one — which is the difference between a download cap that
    /// holds and one a slow drip walks straight through.
    chunk_size: Mutex<Option<usize>>,
}

impl FakeHttp {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn with(self: &Arc<Self>, url: &str, status: u16, body: impl Into<Vec<u8>>) -> Arc<Self> {
        self.responses
            .lock()
            .unwrap()
            .insert(url.to_string(), (status, body.into()));
        self.clone()
    }

    /// Deliver every body in `size`-byte chunks instead of one piece.
    pub fn chunked(self: &Arc<Self>, size: usize) -> Arc<Self> {
        *self.chunk_size.lock().unwrap() = Some(size.max(1));
        self.clone()
    }

    /// Make every response take `delay`, so concurrent callers overlap.
    pub fn slow(self: &Arc<Self>, delay: std::time::Duration) -> Arc<Self> {
        *self.delay.lock().unwrap() = Some(delay);
        self.clone()
    }

    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    pub fn request_count(&self, url: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|requested| *requested == url)
            .count()
    }
}

impl HttpClient for FakeHttp {
    fn get(&self, url: &str) -> BoxFuture<'static, Result<HttpResponse>> {
        self.requests.lock().unwrap().push(url.to_string());
        let (status, body) = self
            .responses
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .unwrap_or((404, b"not found".to_vec()));
        let delay = *self.delay.lock().unwrap();
        let chunk_size = *self.chunk_size.lock().unwrap();
        Box::pin(async move {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let chunks: Vec<Vec<u8>> = match chunk_size {
                Some(size) if !body.is_empty() => {
                    body.chunks(size).map(<[u8]>::to_vec).collect()
                }
                _ => vec![body],
            };
            Ok(HttpResponse {
                status,
                body: futures::stream::iter(chunks.into_iter().map(Ok)).boxed(),
            })
        })
    }
}
