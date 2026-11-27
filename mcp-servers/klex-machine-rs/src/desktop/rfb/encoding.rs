//! Pixel formats and the Raw and Tight rectangle encodings.

use std::collections::HashMap;
use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;

use super::TileRect;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelFormat {
    pub bits_per_pixel: u8,
    pub depth: u8,
    pub big_endian: bool,
    pub true_color: bool,
    pub red_max: u16,
    pub green_max: u16,
    pub blue_max: u16,
    pub red_shift: u8,
    pub green_shift: u8,
    pub blue_shift: u8,
}

/// BGRX in memory: 32-bit little-endian 0x00RRGGBB, what captures produce.
pub const SERVER_PIXEL_FORMAT: PixelFormat = PixelFormat {
    bits_per_pixel: 32,
    depth: 24,
    big_endian: false,
    true_color: true,
    red_max: 255,
    green_max: 255,
    blue_max: 255,
    red_shift: 16,
    green_shift: 8,
    blue_shift: 0,
};

pub const ENCODING_RAW: i32 = 0;
pub const ENCODING_TIGHT: i32 = 7;

const TIGHT_FILL: u8 = 0x80;
const TIGHT_JPEG: u8 = 0x90;
const TIGHT_EXPLICIT_FILTER: u8 = 0x40;
const TIGHT_FILTER_PALETTE: u8 = 1;
const TIGHT_MIN_TO_COMPRESS: usize = 12;
const TIGHT_MAX_PALETTE: usize = 256;

/// Maps Tight's 0 to 9 quality levels to JPEG quality, as TigerVNC does.
pub const JPEG_QUALITY_BY_LEVEL: [u8; 10] = [15, 29, 41, 42, 62, 77, 79, 86, 92, 100];

impl PixelFormat {
    pub fn write(&self) -> [u8; 16] {
        let mut out = [0; 16];
        out[0] = self.bits_per_pixel;
        out[1] = self.depth;
        out[2] = u8::from(self.big_endian);
        out[3] = u8::from(self.true_color);
        out[4..6].copy_from_slice(&self.red_max.to_be_bytes());
        out[6..8].copy_from_slice(&self.green_max.to_be_bytes());
        out[8..10].copy_from_slice(&self.blue_max.to_be_bytes());
        out[10] = self.red_shift;
        out[11] = self.green_shift;
        out[12] = self.blue_shift;
        out
    }

    /// Reads the 16-byte PIXEL_FORMAT at the start of `data`.
    pub fn read(data: &[u8]) -> Self {
        let u16_at = |at: usize| u16::from_be_bytes([data[at], data[at + 1]]);
        Self {
            bits_per_pixel: data[0],
            depth: data[1],
            big_endian: data[2] != 0,
            true_color: data[3] != 0,
            red_max: u16_at(4),
            green_max: u16_at(6),
            blue_max: u16_at(8),
            red_shift: data[10],
            green_shift: data[11],
            blue_shift: data[12],
        }
    }

    /// Why a client pixel format cannot be served, or `None` when it can.
    pub fn unsupported(&self) -> Option<String> {
        if !self.true_color {
            return Some("colour-map pixel formats are not supported".into());
        }
        if ![8, 16, 32].contains(&self.bits_per_pixel) {
            return Some(format!(
                "{} bits per pixel is not supported",
                self.bits_per_pixel
            ));
        }
        for (max, shift) in [
            (self.red_max, self.red_shift),
            (self.green_max, self.green_shift),
            (self.blue_max, self.blue_shift),
        ] {
            let bits = 16 - max.leading_zeros();
            if max == 0 || u32::from(shift) + bits > 32 {
                return Some("the pixel format has an invalid colour channel".into());
            }
        }
        None
    }

    /// Tight sends 3-byte RGB pixels only for 8-bit channels in 32 bits.
    pub fn tight_compatible(&self) -> bool {
        self.bits_per_pixel == 32
            && self.depth == 24
            && self.true_color
            && self.red_max == 255
            && self.green_max == 255
            && self.blue_max == 255
    }

    pub fn key(&self) -> [u8; 16] {
        self.write()
    }
}

pub fn rect_header(rect: TileRect, encoding: i32) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    out.extend_from_slice(&(rect.x as u16).to_be_bytes());
    out.extend_from_slice(&(rect.y as u16).to_be_bytes());
    out.extend_from_slice(&(rect.width as u16).to_be_bytes());
    out.extend_from_slice(&(rect.height as u16).to_be_bytes());
    out.extend_from_slice(&encoding.to_be_bytes());
    out
}

fn channel_table(max: u16, shift: u8) -> [u32; 256] {
    let mut table = [0u32; 256];
    for (value, entry) in table.iter_mut().enumerate() {
        let scaled = ((value as f64 * f64::from(max)) / 255.0 + 0.5).floor() as u64;
        *entry = (scaled << shift) as u32;
    }
    table
}

/// Raw encoding: BGRX pixels converted to the client's pixel format.
pub fn encode_raw(bgrx: &[u8], format: &PixelFormat) -> Vec<u8> {
    let bytes = usize::from(format.bits_per_pixel >> 3);
    let red = channel_table(format.red_max, format.red_shift);
    let green = channel_table(format.green_max, format.green_shift);
    let blue = channel_table(format.blue_max, format.blue_shift);
    let mut out = Vec::with_capacity(bgrx.len() / 4 * bytes);
    for pixel in bgrx.as_chunks::<4>().0 {
        let value = red[pixel[2] as usize] | green[pixel[1] as usize] | blue[pixel[0] as usize];
        match (bytes, format.big_endian) {
            (4, true) => out.extend_from_slice(&value.to_be_bytes()),
            (4, false) => out.extend_from_slice(&value.to_le_bytes()),
            (2, true) => out.extend_from_slice(&(value as u16).to_be_bytes()),
            (2, false) => out.extend_from_slice(&(value as u16).to_le_bytes()),
            _ => out.push(value as u8),
        }
    }
    out
}

/// Tight encoding of BGRX pixels without JPEG: a fill for one colour, an
/// indexed palette up to 256 colours, full RGB otherwise. Every compressed
/// rect resets its zlib stream, so the output depends on the pixels alone
/// and can be shared between viewers.
pub fn encode_tight(bgrx: &[u8], width: u32, height: u32, zlib_level: u32) -> Vec<u8> {
    let count = width as usize * height as usize;
    let mut palette: HashMap<u32, u8> = HashMap::new();
    let mut colors: Vec<u32> = Vec::new();
    let mut indices = vec![0u8; count];
    let mut overflow = false;
    for (index, pixel) in bgrx.as_chunks::<4>().0.iter().take(count).enumerate() {
        let color = (u32::from(pixel[2]) << 16) | (u32::from(pixel[1]) << 8) | u32::from(pixel[0]);
        let entry = match palette.get(&color) {
            Some(entry) => *entry,
            None => {
                if colors.len() == TIGHT_MAX_PALETTE {
                    overflow = true;
                    break;
                }
                let entry = colors.len() as u8;
                palette.insert(color, entry);
                colors.push(color);
                entry
            }
        };
        indices[index] = entry;
    }
    if !overflow && colors.len() == 1 {
        let value = colors[0];
        return vec![
            TIGHT_FILL,
            (value >> 16) as u8,
            (value >> 8) as u8,
            value as u8,
        ];
    }
    if !overflow && colors.len() > 1 {
        let stream: u8 = if colors.len() == 2 { 1 } else { 2 };
        let mut out = vec![
            (stream << 4) | TIGHT_EXPLICIT_FILTER | (1 << stream),
            TIGHT_FILTER_PALETTE,
            (colors.len() - 1) as u8,
        ];
        for color in &colors {
            out.extend_from_slice(&[(color >> 16) as u8, (color >> 8) as u8, *color as u8]);
        }
        let data = if colors.len() == 2 {
            let row_bytes = (width as usize).div_ceil(8);
            let mut data = vec![0u8; row_bytes * height as usize];
            for y in 0..height as usize {
                for x in 0..width as usize {
                    if indices[y * width as usize + x] != 0 {
                        data[y * row_bytes + (x >> 3)] |= 0x80 >> (x & 7);
                    }
                }
            }
            data
        } else {
            indices
        };
        out.extend_from_slice(&tight_data(&data, zlib_level));
        return out;
    }
    let mut rgb = Vec::with_capacity(count * 3);
    for pixel in bgrx.as_chunks::<4>().0.iter().take(count) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    let mut out = vec![1];
    out.extend_from_slice(&tight_data(&rgb, zlib_level));
    out
}

pub fn encode_tight_jpeg(jpeg: &[u8]) -> Vec<u8> {
    let mut out = vec![TIGHT_JPEG];
    out.extend_from_slice(&compact_length(jpeg.len()));
    out.extend_from_slice(jpeg);
    out
}

fn tight_data(data: &[u8], zlib_level: u32) -> Vec<u8> {
    if data.len() < TIGHT_MIN_TO_COMPRESS {
        return data.to_vec();
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(zlib_level.min(9)));
    let _ = encoder.write_all(data);
    let compressed = encoder.finish().unwrap_or_default();
    let mut out = compact_length(compressed.len());
    out.extend_from_slice(&compressed);
    out
}

/// Tight lengths are at most 22 bits; tiles are far smaller.
pub fn compact_length(length: usize) -> Vec<u8> {
    if length < 0x80 {
        vec![length as u8]
    } else if length < 0x4000 {
        vec![(length & 0x7f) as u8 | 0x80, (length >> 7) as u8]
    } else {
        vec![
            (length & 0x7f) as u8 | 0x80,
            ((length >> 7) & 0x7f) as u8 | 0x80,
            (length >> 14) as u8,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    fn bgrx(colors: &[u32]) -> Vec<u8> {
        colors
            .iter()
            .flat_map(|color| color.to_le_bytes())
            .collect()
    }

    #[test]
    fn raw_converts_to_the_client_format() {
        let pixels = bgrx(&[0x00ff_8000]);
        assert_eq!(
            encode_raw(&pixels, &SERVER_PIXEL_FORMAT),
            vec![0x00, 0x80, 0xff, 0x00]
        );
        let rgb565 = PixelFormat {
            bits_per_pixel: 16,
            depth: 16,
            big_endian: true,
            true_color: true,
            red_max: 31,
            green_max: 63,
            blue_max: 31,
            red_shift: 11,
            green_shift: 5,
            blue_shift: 0,
        };
        assert_eq!(rgb565.unsupported(), None);
        let value: u16 = (31 << 11) | (32 << 5);
        assert_eq!(encode_raw(&pixels, &rgb565), value.to_be_bytes().to_vec());
    }

    #[test]
    fn tight_picks_fill_palette_or_full_colour() {
        assert_eq!(
            encode_tight(&bgrx(&[0x123456; 4]), 2, 2, 6),
            vec![0x80, 0x12, 0x34, 0x56]
        );
        let two = encode_tight(&bgrx(&[1, 2, 2, 1]), 2, 2, 6);
        assert_eq!(&two[..3], &[0x52, 1, 1]);
        assert_eq!(&two[9..], &[0x40, 0x80]);
        let many: Vec<u32> = (0..300).collect();
        let full = encode_tight(&bgrx(&many), 300, 1, 6);
        assert_eq!(full[0], 1);
        let (length, header) = ((full[1] & 0x7f) as usize | ((full[2] as usize) << 7), 3);
        let mut decoded = Vec::new();
        ZlibDecoder::new(&full[header..header + length])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded.len(), 900);
        assert_eq!(&decoded[3..6], &[0, 0, 1]);
    }

    #[test]
    fn compact_lengths() {
        assert_eq!(compact_length(5), vec![5]);
        assert_eq!(compact_length(200), vec![0xc8, 1]);
        assert_eq!(compact_length(0x4000), vec![0x80, 0x80, 1]);
    }
}
