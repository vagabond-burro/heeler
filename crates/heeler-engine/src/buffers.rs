use std::sync::Arc;

/// Interleaved RGBA, f32 per channel, scene-referred linear working space.
/// Values may exceed 1.0; alpha is straight (not premultiplied).
#[derive(Debug, PartialEq)]
pub struct ImageBuf {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl ImageBuf {
    pub fn try_new(width: usize, height: usize) -> Result<Self, crate::memory::MemoryError> {
        let count = crate::memory::bytes(width, height, 4, 4)? / 4;
        Ok(Self {
            width,
            height,
            data: crate::memory::vector(count, 0.0, "RGBA image")?,
        })
    }

    pub fn new(width: usize, height: usize) -> Self {
        crate::memory::or_unwind(Self::try_new(width, height))
    }

    pub fn filled(width: usize, height: usize, rgba: [f32; 4]) -> Self {
        let mut out = Self::new(width, height);
        for pixel in out.data.chunks_exact_mut(4) {
            pixel.copy_from_slice(&rgba);
        }
        out
    }

    pub fn pixel(&self, x: usize, y: usize) -> [f32; 4] {
        let i = (y * self.width + x) * 4;
        [
            self.data[i],
            self.data[i + 1],
            self.data[i + 2],
            self.data[i + 3],
        ]
    }

    pub fn set_pixel(&mut self, x: usize, y: usize, rgba: [f32; 4]) {
        let i = (y * self.width + x) * 4;
        self.data[i..i + 4].copy_from_slice(&rgba);
    }
}

/// Single-channel f32 buffer, shared representation for masks and channels.
#[derive(Debug, PartialEq)]
pub struct MaskBuf {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl MaskBuf {
    pub fn try_new(width: usize, height: usize) -> Result<Self, crate::memory::MemoryError> {
        let count = crate::memory::bytes(width, height, 1, 4)? / 4;
        Ok(Self {
            width,
            height,
            data: crate::memory::vector(count, 0.0, "mask")?,
        })
    }

    pub fn new(width: usize, height: usize) -> Self {
        crate::memory::or_unwind(Self::try_new(width, height))
    }

    pub fn value(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.width + x]
    }
}

#[derive(Debug, Clone)]
pub enum Value {
    Image(Arc<ImageBuf>),
    Mask(Arc<MaskBuf>),
}

impl Value {
    pub fn as_image(&self) -> Option<&Arc<ImageBuf>> {
        match self {
            Value::Image(i) => Some(i),
            _ => None,
        }
    }

    pub fn as_mask(&self) -> Option<&Arc<MaskBuf>> {
        match self {
            Value::Mask(m) => Some(m),
            _ => None,
        }
    }
}

/// Rec.709 luma coefficients, used everywhere luminance is needed so the
/// engine has exactly one definition of "brightness".
pub fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

impl Clone for ImageBuf {
    fn clone(&self) -> Self {
        let mut out = Self::new(self.width, self.height);
        out.data.copy_from_slice(&self.data);
        out
    }
}
impl Clone for MaskBuf {
    fn clone(&self) -> Self {
        let mut out = Self::new(self.width, self.height);
        out.data.copy_from_slice(&self.data);
        out
    }
}
