/// FNV-1a 64-bit. Used for cache keys; deliberately not std's RandomState
/// so keys are stable across runs and, later, across processes for the
/// on-disk render cache.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub struct Hasher(u64);

impl Hasher {
    pub fn new() -> Self {
        Hasher(0xcbf29ce484222325)
    }

    pub fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= *b as u64;
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    pub fn write_u64(&mut self, v: u64) {
        self.write(&v.to_le_bytes());
    }

    pub fn finish(&self) -> u64 {
        self.0
    }
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}
