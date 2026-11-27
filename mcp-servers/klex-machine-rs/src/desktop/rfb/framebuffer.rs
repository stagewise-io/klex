use std::collections::HashMap;
use std::sync::Arc;

use super::{STREAM_TILE_SIZE, TileRect};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum EncodedKey {
    Jpeg,
    Tight(u32),
    Raw([u8; 16]),
}

pub struct Tile {
    pub rect: TileRect,
    /// Bumped on every change; 0 until the tile first arrives.
    pub version: u32,
    /// The tile's current content when a capture sent it as JPEG.
    pub jpeg: Option<Arc<Vec<u8>>>,
    /// Encoded rects for the current version, keyed by encoding and format.
    pub encoded: HashMap<EncodedKey, Arc<Vec<u8>>>,
}

enum Staged {
    Raw(usize, Vec<u8>),
    Jpeg(usize, Vec<u8>),
}

/// The latest content of the desktop as a grid of tiles. Lossless tiles keep
/// their BGRX pixels; JPEG tiles keep the JPEG, since every viewer that can
/// be sent one decodes it. Tiles of a frame are staged and applied together.
pub struct Framebuffer {
    pub width: u32,
    pub height: u32,
    pub tiles: Vec<Tile>,
    columns: u32,
    pixels: Vec<u8>,
    staged: Vec<Staged>,
    version: u32,
}

impl Framebuffer {
    pub fn new(width: u32, height: u32) -> Self {
        let size = STREAM_TILE_SIZE;
        let columns = width.div_ceil(size);
        let rows = height.div_ceil(size);
        let mut tiles = Vec::with_capacity((columns * rows) as usize);
        for row in 0..rows {
            for column in 0..columns {
                let (x, y) = (column * size, row * size);
                tiles.push(Tile {
                    rect: TileRect {
                        x,
                        y,
                        width: size.min(width - x),
                        height: size.min(height - y),
                    },
                    version: 0,
                    jpeg: None,
                    encoded: HashMap::new(),
                });
            }
        }
        Self {
            width,
            height,
            tiles,
            columns,
            pixels: vec![0; width as usize * height as usize * 4],
            staged: Vec::new(),
            version: 0,
        }
    }

    /// Stages lossless BGRX pixels for one tile; false when they do not fit.
    pub fn stage_raw(&mut self, rect: TileRect, pixels: Vec<u8>) -> bool {
        match self.index(rect) {
            Some(index) if pixels.len() == rect.width as usize * rect.height as usize * 4 => {
                self.staged.push(Staged::Raw(index, pixels));
                true
            }
            _ => false,
        }
    }

    pub fn stage_jpeg(&mut self, rect: TileRect, jpeg: Vec<u8>) -> bool {
        match self.index(rect) {
            Some(index) if !jpeg.is_empty() => {
                self.staged.push(Staged::Jpeg(index, jpeg));
                true
            }
            _ => false,
        }
    }

    /// Applies the staged tiles; true when any changed.
    pub fn commit(&mut self) -> bool {
        let staged = std::mem::take(&mut self.staged);
        let changed = !staged.is_empty();
        let stride = self.width as usize * 4;
        for update in staged {
            let index = match &update {
                Staged::Raw(index, _) | Staged::Jpeg(index, _) => *index,
            };
            self.version += 1;
            let tile = &mut self.tiles[index];
            tile.version = self.version;
            tile.encoded.clear();
            match update {
                Staged::Jpeg(_, jpeg) => tile.jpeg = Some(Arc::new(jpeg)),
                Staged::Raw(_, pixels) => {
                    tile.jpeg = None;
                    let TileRect {
                        x,
                        y,
                        width,
                        height,
                    } = tile.rect;
                    let row_bytes = width as usize * 4;
                    for row in 0..height as usize {
                        let to = (y as usize + row) * stride + x as usize * 4;
                        self.pixels[to..to + row_bytes]
                            .copy_from_slice(&pixels[row * row_bytes..(row + 1) * row_bytes]);
                    }
                }
            }
        }
        changed
    }

    /// The tile's BGRX pixels; meaningless for a JPEG tile.
    pub fn pixels(&self, index: usize) -> Vec<u8> {
        let TileRect {
            x,
            y,
            width,
            height,
        } = self.tiles[index].rect;
        let stride = self.width as usize * 4;
        let row_bytes = width as usize * 4;
        let mut out = Vec::with_capacity(row_bytes * height as usize);
        for row in 0..height as usize {
            let from = (y as usize + row) * stride + x as usize * 4;
            out.extend_from_slice(&self.pixels[from..from + row_bytes]);
        }
        out
    }

    fn index(&self, rect: TileRect) -> Option<usize> {
        let size = STREAM_TILE_SIZE;
        if !rect.x.is_multiple_of(size) || !rect.y.is_multiple_of(size) {
            return None;
        }
        let index = ((rect.y / size) * self.columns + rect.x / size) as usize;
        self.tiles
            .get(index)
            .filter(|tile| tile.rect == rect)
            .map(|_| index)
    }
}
