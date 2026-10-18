//! The linear decoder's admission covers tiles running side by side and
//! whole row requests without retaining every decoded tile.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use heeler_raw::{linear_dng::{synthetic_dng, LinearDng}, DevelopOpts};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
fn grew(n: usize) {
    let live = LIVE.fetch_add(n, Ordering::Relaxed) + n;
    PEAK.fetch_max(live, Ordering::Relaxed);
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() { grew(l.size()); }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(l);
        if !p.is_null() { grew(l.size()); }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = System.realloc(p, l, n);
        if !q.is_null() {
            if n >= l.size() { grew(n - l.size()); }
            else { LIVE.fetch_sub(l.size() - n, Ordering::Relaxed); }
        }
        q
    }
}
#[global_allocator]
static ALLOC: Counting = Counting;

#[test]
fn linear_tile_workspace_covers_the_live_heap() {
    use heeler_engine::memory::{self, Job};
    let pool = rayon::ThreadPoolBuilder::new().num_threads(8).build().unwrap();
    pool.install(|| {
        // Warm the workers before measuring their decode allocations.
        let warm = LinearDng::open(synthetic_dng(64, 64, 32, 32, 1, |_, _| [100; 3]), DevelopOpts::default()).unwrap().unwrap();
        warm.data_maximum().unwrap();
        drop(warm);
        for (orientation, height) in [(1, 32768), (6, 4096)] {
            let dng = LinearDng::open(synthetic_dng(512, height, 512, 512, orientation, |y, x| [((x + y) % 1024) as u16; 3]), DevelopOpts::default()).unwrap().unwrap();
            let admitted = dng.bytes() + dng.workspace().unwrap();
            assert!(matches!(memory::with_budget(admitted - 1, || dng.data_maximum()), Err(heeler_raw::RawError::Memory(_))));
            let baseline = LIVE.load(Ordering::Relaxed);
            PEAK.store(baseline, Ordering::Relaxed);
            let maximum = memory::with_budget(admitted, || dng.data_maximum()).unwrap();
            assert!(PEAK.load(Ordering::Relaxed) - baseline <= dng.workspace().unwrap());
            let n = dng.numbers(maximum, 0);
            let baseline = LIVE.load(Ordering::Relaxed);
            PEAK.store(baseline, Ordering::Relaxed);
            memory::with_budget(admitted, || dng.count_at_white(&n, 64000)).unwrap();
            assert!(PEAK.load(Ordering::Relaxed) - baseline <= dng.workspace().unwrap());
            let (w, h) = dng.size();
            let output = w * h * 6;
            let ceiling = admitted + output;
            let baseline = LIVE.load(Ordering::Relaxed);
            PEAK.store(baseline, Ordering::Relaxed);
            let whole = memory::with_budget(ceiling, || {
                let job = Job::admit(ceiling, "linear rows test").unwrap();
                job.worker(ceiling).run(|| dng.rows(&n, 0, h)).unwrap()
            });
            assert!(PEAK.load(Ordering::Relaxed) - baseline <= dng.workspace().unwrap() + output);
            for (a, b) in [(0, 1), (h / 2, h / 2 + 7), (h - 1, h)] {
                assert_eq!(dng.rows(&n, a, b).unwrap(), whole[a * w * 3..b * w * 3]);
            }
            assert!(dng.rows(&n, h, h).unwrap().is_empty());
            assert!(dng.rows(&n, h, h + 1).is_err());
        }
    });
}
