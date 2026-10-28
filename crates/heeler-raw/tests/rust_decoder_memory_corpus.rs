//! The shipped develop holds no more than its plan admits (Plan::bytes),
//! on the corpus: one file of each camera folder, full size and half, its
//! heap counted around the develop beyond the file's bytes. The plan
//! itself, made before anything is admitted, is counted too and held to
//! a small cap. Skips when `HEELER_RAW_CORPUS` is unset.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use heeler_rawdec::Opts;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
fn grew(n: usize) {
    let live = LIVE.fetch_add(n, Ordering::Relaxed) + n;
    PEAK.fetch_max(live, Ordering::Relaxed);
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            grew(l.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(l) };
        if !p.is_null() {
            grew(l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            if n >= l.size() {
                grew(n - l.size());
            } else {
                LIVE.fetch_sub(l.size() - n, Ordering::Relaxed);
            }
        }
        q
    }
}
#[global_allocator]
static ALLOC: Counting = Counting;

const EXTS: [&str; 30] = ["DNG", "CR2", "CR3", "ARW", "NEF", "NRW", "RW2", "RAW", "RWL", "ORF", "ORI", "PEF", "SRW", "MRW", "CRW", "RAF", "3FR", "FFF", "ERF", "MEF", "MOS", "IIQ", "GPR", "SR2", "ARQ", "KDC", "DCR", "TIF", "TIFF", "STI"];

/// The first raw file, by name, of every folder under `root` that has one.
fn one_a_folder(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let mut here = Vec::new();
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_ascii_uppercase();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if EXTS.iter().any(|x| name.ends_with(&format!(".{x}"))) {
                here.push(p);
            }
        }
        here.sort();
        out.extend(here.into_iter().next());
    }
    out.sort();
    out
}

/// The most a plan (Plan::new and Plan::bytes) may hold beyond the file,
/// for a file of `len` bytes: it is made before the develop's memory is
/// admitted, so it holds no more than its tables and a share of the file.
fn plan_cap(len: usize) -> usize {
    PLAN_CAP_FIXED + len / 4
}
const PLAN_CAP_FIXED: usize = 4 << 20;

#[test]
fn every_corpus_develop_holds_no_more_than_its_plan_admits() {
    let Some(roots) = std::env::var_os("HEELER_RAW_CORPUS") else {
        eprintln!("HEELER_RAW_CORPUS unset: skipped");
        return;
    };
    // The pool's workers, warmed so their own stacks and buffers are not
    // counted against the first file.
    rayon::broadcast(|_| ());
    let (mut taken, mut over, mut most_planned) = (0, Vec::new(), (0, String::new()));
    for root in std::env::split_paths(&roots) {
        for path in one_a_folder(&root) {
            let Ok(bytes) = std::fs::read(&path) else { continue };
            for half_size in [false, true] {
                let o = Opts { half_size, fixed_white: false, camera_wb: true, camera_matrix: true, highlight: 2, demosaic: -1, libraw_color: false };
                // The plan and its admission, before anything is admitted:
                // held to PLAN_CAP.
                let base = LIVE.load(Ordering::Relaxed);
                PEAK.store(base, Ordering::Relaxed);
                let Ok(plan) = heeler_rawdec::Plan::new(&bytes, &o) else { continue };
                let admitted = plan.bytes(half_size).unwrap();
                let planned = PEAK.load(Ordering::Relaxed) - base;
                let name = path.strip_prefix(&root).unwrap_or(&path).display().to_string();
                most_planned = most_planned.max((planned, name.clone()));
                if planned > plan_cap(bytes.len()) {
                    over.push(format!("{name}: half {half_size}: the plan held {planned}, beyond {}", plan_cap(bytes.len())));
                }
                let base = LIVE.load(Ordering::Relaxed);
                PEAK.store(base, Ordering::Relaxed);
                let done = heeler_rawdec::develop::develop_with(&bytes, &plan, &o, None);
                let held = PEAK.load(Ordering::Relaxed) - base;
                if done.is_err() {
                    continue;
                }
                taken += 1;
                if held > admitted {
                    over.push(format!("{name}: half {half_size}: held {held}, admitted {admitted}"));
                }
            }
        }
    }
    eprintln!("{taken} develops measured; the most a plan held, {} bytes, for {}", most_planned.0, most_planned.1);
    assert!(over.is_empty(), "{} develops hold more than their plan admits:\n{}", over.len(), over.join("\n"));
}
