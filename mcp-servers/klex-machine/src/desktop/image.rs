//! Screenshot encoding and scaling for providers that capture raw pixels.

use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgb};

use super::provider::{ImageFormat, ScreenSize};

pub const SCREENSHOT_JPEG_QUALITY: u8 = 75;

/// Packed 8-bit RGB pixels.
pub struct RgbImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbImage {
    /// From 32-bit BGRX rows, the layout of Windows DIBs and most X11 visuals.
    pub fn from_bgrx(width: u32, height: u32, stride: usize, bgrx: &[u8]) -> Self {
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
        for row in 0..height as usize {
            let start = row * stride;
            for pixel in bgrx[start..start + width as usize * 4].as_chunks::<4>().0 {
                pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
        }
        Self {
            width,
            height,
            pixels,
        }
    }

    /// Scales with a bicubic filter; returns `self` when the size matches.
    pub fn resized(self, size: ScreenSize) -> Self {
        let (width, height) = (size.width.max(1) as u32, size.height.max(1) as u32);
        if width == self.width && height == self.height {
            return self;
        }
        let Some(buffer) =
            ImageBuffer::<Rgb<u8>, Vec<u8>>::from_raw(self.width, self.height, self.pixels)
        else {
            return Self {
                width,
                height,
                pixels: vec![0; width as usize * height as usize * 3],
            };
        };
        let resized = image::imageops::resize(&buffer, width, height, FilterType::CatmullRom);
        Self {
            width,
            height,
            pixels: resized.into_raw(),
        }
    }

    pub fn encode(&self, format: ImageFormat) -> Result<Vec<u8>, String> {
        match format {
            ImageFormat::Jpeg => encode_jpeg(self, SCREENSHOT_JPEG_QUALITY),
            ImageFormat::Png => {
                let mut out = Vec::new();
                PngEncoder::new(&mut out)
                    .write_image(
                        &self.pixels,
                        self.width,
                        self.height,
                        ExtendedColorType::Rgb8,
                    )
                    .map_err(|error| error.to_string())?;
                Ok(out)
            }
        }
    }
}

pub fn encode_jpeg(image: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
        .write_image(
            &image.pixels,
            image.width,
            image.height,
            ExtendedColorType::Rgb8,
        )
        .map_err(|error| error.to_string())?;
    Ok(out)
}

/// An 8-bit RGB PNG with unfiltered rows, byte-for-byte like the TypeScript
/// fake desktop's encoder for the same zlib output.
pub fn encode_plain_png(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    let row_bytes = width as usize * 3;
    let mut raw = Vec::with_capacity((row_bytes + 1) * height as usize);
    for row in rgb.chunks_exact(row_bytes.max(1)).take(height as usize) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    let _ = encoder.write_all(&raw);
    let compressed = encoder.finish().unwrap_or_default();
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    png_chunk(&mut out, b"IHDR", &header);
    png_chunk(&mut out, b"IDAT", &compressed);
    png_chunk(&mut out, b"IEND", &[]);
    out
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_png_round_trips() {
        let rgb: Vec<u8> = (0..2 * 3 * 3).map(|value| value as u8 * 10).collect();
        let png = encode_plain_png(3, 2, &rgb);
        let decoded = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
        assert_eq!(decoded.into_raw(), rgb);
    }

    #[test]
    fn bgrx_converts_and_resizes() {
        let bgrx = [1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9];
        let image = RgbImage::from_bgrx(2, 1, 12, &bgrx);
        assert_eq!(image.pixels, vec![3, 2, 1, 6, 5, 4]);
        let image = image.resized(ScreenSize {
            width: 4,
            height: 2,
        });
        assert_eq!(image.pixels.len(), 4 * 2 * 3);
        assert!(
            image
                .encode(ImageFormat::Jpeg)
                .unwrap()
                .starts_with(&[0xff, 0xd8])
        );
        assert!(
            image
                .encode(ImageFormat::Png)
                .unwrap()
                .starts_with(&[0x89, b'P'])
        );
    }
}
