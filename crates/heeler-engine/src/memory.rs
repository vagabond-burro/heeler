//! Shared admission for whole-frame work. The platform snapshot is taken once;
//! reservations cover concurrent work, and weak cache entries count live pixels
//! once even when the decode, proxy, raster and executor caches share an Arc.
use crate::{ImageBuf, MaskBuf};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum MemoryError {
    #[error("Cannot allocate {0}: the image dimensions exceed addressable memory")]
    Geometry(String),
    #[error("Not enough memory for {purpose}: needs about {needed_mib} MiB, with {available_mib} MiB available (about {shortfall_mib} MiB more needed). Close other images or use a smaller preview")]
    Admission {
        purpose: String,
        needed_mib: usize,
        available_mib: usize,
        shortfall_mib: usize,
    },
    #[error("Not enough memory to allocate {0}. Close other images and try again")]
    Allocation(String),
}

pub fn bytes(w: usize, h: usize, channels: usize, sample: usize) -> Result<usize, MemoryError> {
    w.checked_mul(h)
        .and_then(|v| v.checked_mul(channels))
        .and_then(|v| v.checked_mul(sample))
        .filter(|v| *v <= isize::MAX as usize)
        .ok_or_else(|| MemoryError::Geometry(format!("{w} by {h}, {channels} channels")))
}
pub fn sum(parts: impl IntoIterator<Item = usize>) -> Result<usize, MemoryError> {
    parts.into_iter().try_fold(0usize, |a, b| {
        a.checked_add(b)
            .filter(|v| *v <= isize::MAX as usize)
            .ok_or_else(|| MemoryError::Geometry("working buffers".into()))
    })
}
fn mib(n: usize) -> usize {
    n.div_ceil(1 << 20)
}
fn refusal(purpose: &str, needed: usize, available: usize) -> MemoryError {
    MemoryError::Admission {
        purpose: purpose.into(),
        needed_mib: mib(needed),
        available_mib: available >> 20,
        shortfall_mib: mib(needed.saturating_sub(available)),
    }
}

/// Funds available to this thread, including its already admitted job.
pub fn available_to_job() -> usize {
    if let Some(limit) = WORKER_LIMIT.with(|l| l.get()) {
        return limit;
    }
    let reserved = ACTIVE
        .with(|a| a.borrow().last().map(|j| j.bytes()))
        .unwrap_or(0);
    budget().available().saturating_add(reserved)
}

pub fn vector<T: Clone>(count: usize, value: T, purpose: &str) -> Result<Vec<T>, MemoryError> {
    let size = bytes(count, 1, 1, std::mem::size_of::<T>())?;
    // A single allocation must also fit the admitted job, even if a forged
    // geometry parameter grew it after the initial estimate.
    let ceiling = ACTIVE
        .with(|a| a.borrow().last().map(|j| j.bytes()))
        .unwrap_or_else(|| budget().limit);
    let ceiling = WORKER_LIMIT.with(|l| l.get()).map_or(ceiling, |v| ceiling.min(v));
    if size > ceiling {
        return Err(refusal(purpose, size, ceiling));
    }
    let mut data = Vec::new();
    data.try_reserve_exact(count)
        .map_err(|_| MemoryError::Allocation(purpose.into()))?;
    data.resize(count, value);
    Ok(data)
}

/// Compatibility bridge for pure pixel operators, whose APIs return buffers.
/// Only our typed allocation failure is unwound; job boundaries translate it
/// back to a Result. Other panics retain their normal behavior.
pub fn or_unwind<T>(result: Result<T, MemoryError>) -> T {
    result.unwrap_or_else(|e| std::panic::resume_unwind(Box::new(e)))
}
pub fn catch<T>(f: impl FnOnce() -> T) -> Result<T, MemoryError> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(v) => Ok(v),
        Err(e) => match e.downcast::<MemoryError>() {
            Ok(e) => Err(*e),
            Err(e) => std::panic::resume_unwind(e),
        },
    }
}
pub fn is_refusal(text: &str) -> bool {
    text.contains("Not enough memory") || text.contains("exceed addressable memory")
}

enum Pixels {
    Image(Weak<ImageBuf>),
    Mask(Weak<MaskBuf>),
}
struct Cached {
    pixels: Pixels,
    owner: Weak<Reservation>,
}
impl Cached {
    fn bytes(&self) -> Option<usize> {
        if self.owner.strong_count() > 0 {
            return Some(0);
        }
        match &self.pixels {
            Pixels::Image(w) => w.upgrade().map(|i| i.data.capacity().saturating_mul(4)),
            Pixels::Mask(w) => w.upgrade().map(|i| i.data.capacity().saturating_mul(4)),
        }
    }
}
struct State {
    running: usize,
    peak: usize,
    caches: HashMap<usize, Cached>,
    external: HashMap<&'static str, (usize, Weak<Reservation>)>,
}
/// Accounted reservations plus live cached buffers, not process RSS.
#[derive(Debug, Clone, Copy)]
pub struct Snapshot {
    pub limit: usize,
    pub resident: usize,
    pub reserved: usize,
    pub peak: usize,
}
pub struct Budget {
    limit: usize,
    state: Mutex<State>,
}
impl Budget {
    pub fn new(available: usize) -> Arc<Self> {
        Arc::new(Self {
            limit: available,
            state: Mutex::new(State {
                running: 0,
                peak: 0,
                caches: HashMap::new(),
                external: HashMap::new(),
            }),
        })
    }
    fn resident(s: &mut State) -> usize {
        let mut total = 0usize;
        s.caches.retain(|_, v| match v.bytes() {
            Some(n) => {
                total = total.saturating_add(n);
                true
            }
            None => false,
        });
        for (n, owner) in s.external.values() {
            if owner.strong_count() == 0 {
                total = total.saturating_add(*n);
            }
        }
        total
    }
    pub fn snapshot(&self) -> Snapshot {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let resident = Self::resident(&mut s);
        s.peak = s.peak.max(resident.saturating_add(s.running));
        Snapshot { limit: self.limit, resident, reserved: s.running, peak: s.peak }
    }
    pub fn available(&self) -> usize {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.limit
            .saturating_sub(Self::resident(&mut s))
            .saturating_sub(s.running)
    }
    pub fn set_external(&self, key: &'static str, bytes: usize) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.external.get(key).is_some_and(|(n, _)| *n == bytes) {
            return;
        }
        let owner = ACTIVE.with(|a| a.borrow().last().map(Arc::downgrade).unwrap_or_default());
        s.external.insert(key, (bytes, owner));
    }
    /// What a named external charge currently stands at (0 when unset).
    pub fn external(&self, key: &str) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .external
            .get(key)
            .map(|(n, _)| *n)
            .unwrap_or(0)
    }
    pub fn image_is_resident(&self, i: &Arc<ImageBuf>) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .caches
            .get(&(Arc::as_ptr(i) as usize))
            .is_some_and(|c| c.owner.strong_count() == 0 && c.bytes().is_some())
    }
    pub fn mask_is_resident(&self, i: &Arc<MaskBuf>) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .caches
            .get(&(Arc::as_ptr(i) as usize))
            .is_some_and(|c| c.owner.strong_count() == 0 && c.bytes().is_some())
    }
    pub fn track_image(&self, i: &Arc<ImageBuf>) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .caches
            .entry(Arc::as_ptr(i) as usize)
            .or_insert_with(|| Cached {
                pixels: Pixels::Image(Arc::downgrade(i)),
                owner: ACTIVE.with(|a| a.borrow().last().map(Arc::downgrade).unwrap_or_default()),
            });
    }
    pub fn track_mask(&self, i: &Arc<MaskBuf>) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .caches
            .entry(Arc::as_ptr(i) as usize)
            .or_insert_with(|| Cached {
                pixels: Pixels::Mask(Arc::downgrade(i)),
                owner: ACTIVE.with(|a| a.borrow().last().map(Arc::downgrade).unwrap_or_default()),
            });
    }
    pub fn reserve(
        self: &Arc<Self>,
        needed: usize,
        purpose: &str,
    ) -> Result<Arc<Reservation>, MemoryError> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let available = self
            .limit
            .saturating_sub(Self::resident(&mut s))
            .saturating_sub(s.running);
        if needed > available {
            return Err(refusal(purpose, needed, available));
        }
        s.running += needed;
        s.peak = s.peak.max(self.limit.saturating_sub(available).saturating_add(needed));
        Ok(Arc::new(Reservation {
            budget: self.clone(),
            size: Mutex::new(needed),
        }))
    }
}
pub struct Reservation {
    budget: Arc<Budget>,
    size: Mutex<usize>,
}
impl Reservation {
    pub fn bytes(&self) -> usize {
        *self.size.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn grow(&self, needed: usize, purpose: &str) -> Result<(), MemoryError> {
        let mut size = self.size.lock().unwrap_or_else(|e| e.into_inner());
        if needed <= *size {
            return Ok(());
        }
        let mut s = self.budget.state.lock().unwrap_or_else(|e| e.into_inner());
        let available = self
            .budget
            .limit
            .saturating_sub(Budget::resident(&mut s))
            .saturating_sub(s.running);
        let extra = needed - *size;
        if extra > available {
            return Err(refusal(purpose, needed, available.saturating_add(*size)));
        }
        s.running += extra;
        s.peak = s.peak.max(self.budget.limit.saturating_sub(available).saturating_add(extra));
        *size = needed;
        Ok(())
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let bytes = self.bytes();
        self.budget
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .running -= bytes;
    }
}
thread_local! { static ACTIVE: RefCell<Vec<Arc<Reservation>>> = const { RefCell::new(Vec::new()) }; }
thread_local! { static PREVIEW_NOTICE: RefCell<Option<String>> = const { RefCell::new(None) }; }
pub fn note_preview_reduction(message: String) {
    PREVIEW_NOTICE.with(|n| {
        n.borrow_mut().get_or_insert(message);
    });
}
pub fn take_preview_notice() -> Option<String> {
    PREVIEW_NOTICE.with(|n| n.borrow_mut().take())
}

thread_local! { static RETAINED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
/// A recipe retains earlier members while the next decoder runs. Include
/// those bytes even when that decoder needs to grow the shared reservation.
pub fn with_retained<T>(bytes: usize, f: impl FnOnce() -> T) -> T {
    struct Reset(usize);
    impl Drop for Reset {
        fn drop(&mut self) {
            RETAINED.with(|r| r.set(self.0));
        }
    }
    let old = RETAINED.with(|r| r.get());
    let total = or_unwind(sum([old, bytes]));
    let _reset = Reset(old);
    RETAINED.with(|r| r.set(total));
    f()
}

/// Nested decode/render stages share one high-water estimate, rather than
/// charging the same working frame again at each function boundary.
pub struct Job(std::marker::PhantomData<std::rc::Rc<()>>);
impl Job {
    pub fn admit(needed: usize, purpose: &str) -> Result<Self, MemoryError> {
        let needed = sum([needed, RETAINED.with(|r| r.get())])?;
        if let Some(limit) = WORKER_LIMIT.with(|l| l.get()) {
            if needed > limit {
                return Err(refusal(purpose, needed, limit));
            }
        }
        let current = ACTIVE.with(|a| a.borrow().last().cloned());
        let job = if let Some(j) = current {
            j.grow(needed, purpose)?;
            j
        } else {
            budget().reserve(needed, purpose)?
        };
        ACTIVE.with(|a| a.borrow_mut().push(job));
        Ok(Self(std::marker::PhantomData))
    }
}
impl Job {
    /// Lend a paid slice to each concurrent decoder. Workers cannot grow
    /// it, so an unexpectedly large member cannot spend another slice.
    pub fn worker(&self, limit: usize) -> WorkerJob {
        WorkerJob {
            reservation: ACTIVE.with(|a| a.borrow().last().unwrap().clone()),
            limit: limit.min(ACTIVE.with(|a| a.borrow().last().unwrap().bytes())),
        }
    }
}
thread_local! { static WORKER_LIMIT: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }
pub struct WorkerJob {
    reservation: Arc<Reservation>,
    limit: usize,
}
impl WorkerJob {
    pub fn run<T>(&self, f: impl FnOnce() -> T) -> T {
        struct Reset {
            budget: Option<Arc<Budget>>,
            limit: Option<usize>,
            retained: usize,
        }
        impl Drop for Reset {
            fn drop(&mut self) {
                ACTIVE.with(|a| a.borrow_mut().pop());
                THREAD_BUDGET.with(|b| *b.borrow_mut() = self.budget.take());
                WORKER_LIMIT.with(|l| l.set(self.limit));
                RETAINED.with(|r| r.set(self.retained));
            }
        }
        let _reset = Reset {
            budget: THREAD_BUDGET.with(|b| b.replace(Some(self.reservation.budget.clone()))),
            limit: WORKER_LIMIT.with(|l| l.replace(Some(self.limit))),
            retained: RETAINED.with(|r| r.replace(0)),
        };
        ACTIVE.with(|a| a.borrow_mut().push(self.reservation.clone()));
        f()
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        ACTIVE.with(|a| a.borrow_mut().pop());
    }
}

thread_local! {
    /// The budget this thread answers to in place of the machine's. Two
    /// things set it: a test injecting a machine figure (with_budget),
    /// and a merge worker inheriting its parent job's budget
    /// (WorkerJob::run), since a rayon thread has none of the admitting
    /// thread's state. It was named for the first alone while the
    /// second ran in production on it (2026-10-06 review).
    static THREAD_BUDGET: RefCell<Option<Arc<Budget>>> = const { RefCell::new(None) };
}
/// Inject a machine figure without changing other threads or reserving real RAM.
#[doc(hidden)]
pub fn with_budget<T>(limit: usize, f: impl FnOnce() -> T) -> T {
    struct Reset(Option<Arc<Budget>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            THREAD_BUDGET.with(|b| *b.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(THREAD_BUDGET.with(|b| b.replace(Some(Budget::new(limit)))));
    f()
}
pub fn budget() -> Arc<Budget> {
    if let Some(b) = THREAD_BUDGET.with(|b| b.borrow().clone()) {
        return b;
    }
    static BUDGET: OnceLock<Arc<Budget>> = OnceLock::new();
    BUDGET
        .get_or_init(|| Budget::new(machine_memory().unwrap_or(NO_LIMIT)))
        .clone()
}

/// The allowance when the machine cannot be asked: no admission at all,
/// only the geometry checks. A probe that fails (a sandbox without the
/// tool, an unknown platform) must never turn into an app that refuses
/// every photograph; the guard exists for the forged and the absurd,
/// and without a figure the operating system's own paging is the answer
/// it always was.
const NO_LIMIT: usize = usize::MAX >> 2;

/// The machine's physical memory, read once. Physical memory, not the
/// free pages of the moment: free memory on a modern desktop is a
/// snapshot that the operating system spends on caches and reclaims on
/// demand, so a figure taken at startup decays into refusing work the
/// machine would have done with paging and compression. The allowance
/// is what the machine HAS; the caches and jobs this budget counts are
/// what is spent against it.
#[cfg(target_os = "macos")]
fn machine_memory() -> Option<usize> {
    // sysctl's own binary, no shell, no dependency, once.
    let output = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_memsize(std::str::from_utf8(&output.stdout).ok()?)
}
#[cfg(any(target_os = "macos", test))]
fn parse_memsize(text: &str) -> Option<usize> {
    text.trim().parse::<usize>().ok().filter(|n| *n > 0)
}
#[cfg(target_os = "linux")]
fn machine_memory() -> Option<usize> {
    let s = std::fs::read_to_string("/proc/meminfo").ok()?;
    s.lines()
        .find(|l| l.starts_with("MemTotal:"))?
        .split_whitespace()
        .nth(1)?
        .parse::<usize>()
        .ok()?
        .checked_mul(1024)
}
#[cfg(target_os = "windows")]
fn machine_memory() -> Option<usize> {
    #[repr(C)]
    struct Status {
        length: u32,
        load: u32,
        total: u64,
        available: u64,
        page_total: u64,
        page_available: u64,
        virtual_total: u64,
        virtual_available: u64,
        extended: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(status: *mut Status) -> i32;
    }
    let mut s = Status {
        length: std::mem::size_of::<Status>() as u32,
        load: 0,
        total: 0,
        available: 0,
        page_total: 0,
        page_available: 0,
        virtual_total: 0,
        virtual_available: 0,
        extended: 0,
    };
    if unsafe { GlobalMemoryStatusEx(&mut s) } == 0 {
        None
    } else {
        usize::try_from(s.total).ok()
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn machine_memory() -> Option<usize> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_workers_decoder_limits_see_only_its_paid_slice() {
        with_budget(1000, || {
            let job = Job::admit(300, "parent").unwrap();
            job.worker(100).run(|| assert_eq!(available_to_job(), 100));
            assert_eq!(available_to_job(), 1000);
        });
    }

    #[test]
    fn worker_slices_cannot_grow_and_restore_the_calling_thread_after_unwind() {
        with_budget(1000, || {
            let job = Job::admit(300, "parent").unwrap();
            let worker = job.worker(500);
            worker.run(|| {
                assert_eq!(budget().snapshot().reserved, 300);
                assert!(Job::admit(301, "oversized member").is_err());
                assert!(vector(301, 0u8, "oversized samples").is_err());
            });
            let worker = job.worker(100);
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.run(|| panic!("test worker unwind")))).is_err());
            assert!(Job::admit(400, "parent can grow again").is_ok());
            assert_eq!(budget().snapshot().reserved, 400);
        });
    }

    #[test]
    fn geometry_refuses_overflow_without_allocating() {
        assert!(bytes(usize::MAX, 2, 4, 4).is_err());
        assert!(ImageBuf::try_new(usize::MAX, 2).is_err());
        assert!(catch(|| ImageBuf::new(usize::MAX, 2)).is_err());
    }
    #[test]
    fn a_real_24mp_job_fits_a_few_gigabytes() {
        let b = Budget::new(3 << 30);
        let frame = bytes(6000, 4000, 4, 4).unwrap();
        assert!(b.reserve(frame * 6, "decode and render").is_ok());
        assert!(b
            .reserve(bytes(120_000, 100, 4, 4).unwrap() * 6, "wide panorama")
            .is_ok());
    }
    #[test]
    fn concurrent_jobs_and_shared_live_caches_are_counted() {
        let b = Budget::new(1024);
        let img = Arc::new(ImageBuf::new(4, 4));
        b.track_image(&img);
        b.track_image(&img);
        assert_eq!(b.available(), 768);
        let a = b.reserve(512, "first export").unwrap();
        assert!(b.reserve(300, "second export").is_err());
        drop(a);
        assert!(b.reserve(300, "second export").is_ok());
        drop(img);
        assert_eq!(b.available(), 1024);
    }
    #[test]
    fn nested_stages_share_one_reservation_and_failures_release_it() {
        with_budget(1000, || {
            let b = budget();
            {
                let _outer = Job::admit(600, "decode").unwrap();
                let _inner = Job::admit(800, "render").unwrap();
                assert_eq!(b.available(), 200);
                assert!(Job::admit(1200, "export").is_err());
                assert_eq!(b.available(), 200);
            }
            assert_eq!(b.available(), 1000);
        });
    }

    #[test]
    fn cached_job_outputs_are_charged_once_during_and_after_the_job() {
        with_budget(1000, || {
            let b = budget();
            let image;
            {
                let _job = Job::admit(600, "preview").unwrap();
                image = Arc::new(ImageBuf::new(4, 4));
                b.track_image(&image);
                assert_eq!(b.available(), 400);
            }
            assert_eq!(b.available(), 744);
            drop(image);
            assert_eq!(b.available(), 1000);
        });
    }

    #[test]
    fn retained_device_buffers_count_after_their_job_finishes() {
        with_budget(1000, || {
            let b = budget();
            {
                let _job = Job::admit(600, "GPU").unwrap();
                b.set_external("GPU", 400);
                assert_eq!(b.available(), 400);
            }
            assert_eq!(b.available(), 600);
            {
                let _job = Job::admit(200, "readback").unwrap();
                b.set_external("GPU", 400);
                assert_eq!(b.available(), 400);
            }
            b.set_external("GPU", 0);
            assert_eq!(b.available(), 1000);
        });
    }

    #[test]
    fn a_growing_decoder_keeps_earlier_recipe_members_charged() {
        with_budget(1000, || {
            let _job = Job::admit(0, "recipe").unwrap();
            with_retained(300, || {
                let _decode = Job::admit(600, "next frame").unwrap();
                assert_eq!(budget().available(), 100);
                assert!(Job::admit(800, "larger decoder workspace").is_err());
            });
            assert!(Job::admit(1000, "merge including members").is_ok());
        });
    }

    #[test]
    fn the_mac_figure_is_physical_memory_and_a_failed_probe_refuses_nothing() {
        assert_eq!(parse_memsize("17179869184\n"), Some(17179869184));
        assert_eq!(parse_memsize("garbage"), None);
        assert_eq!(parse_memsize("0"), None);
        // Without a figure the budget admits any real job: only the
        // geometry checks stand between a forged header and the allocator.
        let b = Budget::new(NO_LIMIT);
        assert!(b.reserve(bytes(120_000, 100_000, 4, 4).unwrap(), "absurd but addressable").is_ok());
    }
}

#[cfg(test)]
mod measurement_tests {
    use super::*;
    #[test]
    fn peak_counts_shared_cache_once_and_keeps_released_reservations() {
        with_budget(10000, || {
            let b=budget();
            let image=Arc::new(ImageBuf::new(10,10));
            b.track_image(&image); b.track_image(&image);
            assert_eq!(b.snapshot().resident,1600);
            {
                let _job=Job::admit(3000,"fixture").unwrap();
                assert_eq!(b.snapshot().peak,4600);
                let _nested=Job::admit(4000,"fixture growth").unwrap();
                assert_eq!(b.snapshot().peak,5600);
            }
            drop(image);
            let m=b.snapshot();
            assert_eq!((m.resident,m.reserved,m.peak),(0,0,5600));
        });
    }
}
