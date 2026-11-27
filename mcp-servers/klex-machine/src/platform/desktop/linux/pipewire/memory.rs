//! Shared memory PipeWire hands out by id: activation records, IO areas,
//! buffer skeletons and frame data.

use std::collections::HashMap;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicI32, AtomicU32, AtomicU64, Ordering};

pub const MEMBLOCK_WRITABLE: u32 = 1 << 1;

struct Block {
    fd: OwnedFd,
    flags: u32,
}

/// Memory blocks announced with `Core::AddMem`.
#[derive(Default)]
pub struct MemPool {
    blocks: HashMap<u32, Block>,
}

impl MemPool {
    pub fn add(&mut self, id: u32, fd: OwnedFd, flags: u32) {
        self.blocks.insert(id, Block { fd, flags });
    }

    pub fn remove(&mut self, id: u32) {
        self.blocks.remove(&id);
    }

    /// Maps `size` bytes at `offset` of block `id`, writable when the block is.
    pub fn map(&self, id: u32, offset: u32, size: u32) -> io::Result<Mapping> {
        let block = self.blocks.get(&id).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, format!("unknown memory {id}"))
        })?;
        Mapping::new(
            &block.fd,
            u64::from(offset),
            size as usize,
            block.flags & MEMBLOCK_WRITABLE != 0,
        )
    }
}

/// One `mmap`ed range, unmapped on drop.
pub struct Mapping {
    base: *mut libc::c_void,
    mapped: usize,
    delta: usize,
    len: usize,
}

// SAFETY: the mapping is plain shared memory owned by this value; access
// goes through bounds-checked methods.
unsafe impl Send for Mapping {}

impl Mapping {
    pub fn new(fd: &OwnedFd, offset: u64, len: usize, writable: bool) -> io::Result<Self> {
        if len == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty mapping"));
        }
        // SAFETY: sysconf has no preconditions.
        let page = (unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).max(4096) as u64;
        let aligned = offset - offset % page;
        let delta = (offset - aligned) as usize;
        let mapped = len + delta;
        let protection = if writable {
            libc::PROT_READ | libc::PROT_WRITE
        } else {
            libc::PROT_READ
        };
        // SAFETY: a fresh shared mapping of a descriptor we hold; the result
        // is checked before use.
        let base = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                mapped,
                protection,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                aligned as libc::off_t,
            )
        };
        if base == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            base,
            mapped,
            delta,
            len,
        })
    }

    pub fn len(&self) -> usize {
        self.len
    }

    fn ptr(&self, at: usize, size: usize) -> Option<*mut u8> {
        (at.checked_add(size)? <= self.len)
            // SAFETY: the offset stays within the mapping.
            .then(|| unsafe { self.base.cast::<u8>().add(self.delta + at) })
    }

    pub fn bytes(&self, at: usize, size: usize) -> Option<&[u8]> {
        // SAFETY: the range is within the mapping, which lives as long as
        // `self`. Another process may write it concurrently, which only
        // affects the bytes read.
        self.ptr(at, size)
            .map(|ptr| unsafe { std::slice::from_raw_parts(ptr, size) })
    }

    pub fn u32_at(&self, at: usize) -> Option<&AtomicU32> {
        // SAFETY: in bounds; PipeWire aligns these fields, and atomics are
        // the right view of memory shared with other processes.
        self.ptr(at, 4)
            .filter(|ptr| ptr.align_offset(4) == 0)
            .map(|ptr| unsafe { &*ptr.cast::<AtomicU32>() })
    }

    pub fn i32_at(&self, at: usize) -> Option<&AtomicI32> {
        // SAFETY: as for `u32_at`.
        self.ptr(at, 4)
            .filter(|ptr| ptr.align_offset(4) == 0)
            .map(|ptr| unsafe { &*ptr.cast::<AtomicI32>() })
    }

    pub fn u64_at(&self, at: usize) -> Option<&AtomicU64> {
        // SAFETY: as for `u32_at`.
        self.ptr(at, 8)
            .filter(|ptr| ptr.align_offset(8) == 0)
            .map(|ptr| unsafe { &*ptr.cast::<AtomicU64>() })
    }

    pub fn load_u32(&self, at: usize) -> Option<u32> {
        self.u32_at(at).map(|value| value.load(Ordering::Acquire))
    }

    pub fn store_u32(&self, at: usize, value: u32) {
        if let Some(slot) = self.u32_at(at) {
            slot.store(value, Ordering::Release);
        }
    }

    pub fn store_u64(&self, at: usize, value: u64) {
        if let Some(slot) = self.u64_at(at) {
            slot.store(value, Ordering::Release);
        }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: unmaps exactly what `new` mapped.
        unsafe { libc::munmap(self.base, self.mapped) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn maps_unaligned_ranges() {
        let mut file = tempfile::tempfile().unwrap();
        let data: Vec<u8> = (0..10_000u32).map(|value| value as u8).collect();
        file.write_all(&data).unwrap();
        let mut pool = MemPool::default();
        pool.add(3, file.into(), MEMBLOCK_WRITABLE);
        let mapping = pool.map(3, 5000, 100).unwrap();
        assert_eq!(mapping.bytes(0, 4).unwrap(), &data[5000..5004]);
        assert!(mapping.bytes(98, 4).is_none());
        mapping.store_u32(4, 0xdead_beef);
        assert_eq!(mapping.load_u32(4), Some(0xdead_beef));
        assert!(pool.map(9, 0, 10).is_err());
    }
}
