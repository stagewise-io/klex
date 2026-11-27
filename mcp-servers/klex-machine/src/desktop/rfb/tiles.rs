//! Turns whole BGRX frames into tile updates for a `StreamSink`: only tiles
//! that changed are sent, busy photographic tiles as JPEG when the viewer
//! allows it, and those again losslessly once they have been still a while.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::{STREAM_TILE_SIZE, StreamSink, TileRect};
use crate::desktop::image::{RgbImage, encode_jpeg};

const PHOTO_COLORS: usize = 64;
/// A tile sent as JPEG goes again losslessly once it has been still this long.
const LOSSLESS_DELAY: Duration = Duration::from_millis(1500);

/// One whole frame: BGRX, rows packed.
#[derive(Clone, Copy)]
pub struct FrameRef<'a> {
    pub width: u32,
    pub height: u32,
    pub bgrx: &'a [u8],
}

#[derive(Default)]
pub struct TileSender {
    width: u32,
    height: u32,
    previous: Vec<u32>,
    /// Per tile: whether it last went out as JPEG, and when it last changed.
    lossy: Vec<bool>,
    changed_at: Vec<Instant>,
}

impl TileSender {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sends what changed in `frame` since the last call, or every tile when
    /// `full`. `fresh` is false when `frame` is the one sent last time, which
    /// skips the comparison. `quality` 0 sends everything losslessly.
    /// `Ok(false)` once the server is gone.
    pub fn send(
        &mut self,
        sink: &StreamSink,
        frame: FrameRef<'_>,
        quality: u8,
        mut full: bool,
        fresh: bool,
    ) -> Result<bool, String> {
        let FrameRef {
            width,
            height,
            bgrx,
        } = frame;
        if bgrx.len() < width as usize * height as usize * 4 || width == 0 || height == 0 {
            return Err("The captured frame is smaller than its size".into());
        }
        if width != self.width || height != self.height {
            let tiles = width.div_ceil(STREAM_TILE_SIZE) as usize
                * height.div_ceil(STREAM_TILE_SIZE) as usize;
            self.width = width;
            self.height = height;
            self.previous = vec![0; width as usize * height as usize];
            self.lossy = vec![false; tiles];
            self.changed_at = vec![Instant::now(); tiles];
            if !sink.resize(width, height) {
                return Ok(false);
            }
            full = true;
        }
        let compare = full || fresh;
        let current: Vec<u32> = if compare {
            bgrx[..width as usize * height as usize * 4]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|pixel| u32::from_le_bytes(*pixel))
                .collect()
        } else {
            Vec::new()
        };
        let now = Instant::now();
        let mut sent = false;
        let mut index = 0;
        let tile = STREAM_TILE_SIZE;
        for ty in (0..height).step_by(tile as usize) {
            for tx in (0..width).step_by(tile as usize) {
                let rect = TileRect {
                    x: tx,
                    y: ty,
                    width: tile.min(width - tx),
                    height: tile.min(height - ty),
                };
                let changed =
                    full || (compare && tile_changed(&current, &self.previous, width, rect));
                let lossless_due =
                    self.lossy[index] && now - self.changed_at[index] >= LOSSLESS_DELAY;
                if changed {
                    copy_tile(&current, &mut self.previous, width, rect);
                    self.changed_at[index] = now;
                }
                if changed || lossless_due {
                    let jpeg = if changed && !full { quality } else { 0 };
                    match send_tile(sink, &self.previous, width, rect, jpeg)? {
                        Some(lossy) => self.lossy[index] = lossy,
                        None => return Ok(false),
                    }
                    sent = true;
                }
                index += 1;
            }
        }
        Ok(!sent || sink.frame())
    }
}

fn rows(width: u32, rect: TileRect) -> impl Iterator<Item = std::ops::Range<usize>> {
    (rect.y..rect.y + rect.height).map(move |y| {
        let start = y as usize * width as usize + rect.x as usize;
        start..start + rect.width as usize
    })
}

fn tile_changed(current: &[u32], previous: &[u32], width: u32, rect: TileRect) -> bool {
    rows(width, rect).any(|row| {
        current[row.clone()]
            .iter()
            .zip(&previous[row])
            .any(|(a, b)| (a ^ b) & 0x00ff_ffff != 0)
    })
}

fn copy_tile(from: &[u32], to: &mut [u32], width: u32, rect: TileRect) {
    for row in rows(width, rect) {
        to[row.clone()].copy_from_slice(&from[row]);
    }
}

/// Text and UI rarely use many colours per tile; every third pixel is enough
/// to tell.
fn photographic(pixels: &[u32], width: u32, rect: TileRect) -> bool {
    let mut colors = HashSet::new();
    let count = rect.width * rect.height;
    for i in (0..count).step_by(3) {
        let (x, y) = (rect.x + i % rect.width, rect.y + i / rect.width);
        colors.insert(pixels[y as usize * width as usize + x as usize] & 0x00ff_ffff);
        if colors.len() > PHOTO_COLORS {
            return true;
        }
    }
    false
}

/// Whether the tile went out as JPEG, or `None` once the server is gone.
fn send_tile(
    sink: &StreamSink,
    pixels: &[u32],
    width: u32,
    rect: TileRect,
    quality: u8,
) -> Result<Option<bool>, String> {
    let mut bgrx = Vec::with_capacity((rect.width * rect.height * 4) as usize);
    for row in rows(width, rect) {
        for pixel in &pixels[row] {
            bgrx.extend_from_slice(&pixel.to_le_bytes());
        }
    }
    if quality > 0 && photographic(pixels, width, rect) {
        let image = RgbImage::from_bgrx(rect.width, rect.height, rect.width as usize * 4, &bgrx);
        let jpeg = encode_jpeg(&image, quality)?;
        return Ok(sink.jpeg(rect, jpeg).then_some(true));
    }
    Ok(sink.raw(rect, bgrx).then_some(false))
}
