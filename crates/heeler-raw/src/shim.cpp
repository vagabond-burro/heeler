// Small C shim over LibRaw internals the C API does not expose.
//
// - heeler_set_half_size: params.half_size skips demosaic interpolation and
//   returns a half-resolution develop (~4x faster). Preview rendering uses
//   it; export-quality decodes leave it off.
// - heeler_silence_data_errors: LibRaw's default data-error callback prints
//   "unknown file: data corrupted at N" to stderr for recoverable warnings
//   (Panasonic S5 II files trip it on every decode). Route it to a no-op;
//   real failures still surface through return codes.

// The library build's declarations: LibRaw's internal member functions
// (the AHD tile steps below) are declared only then. They add functions
// and static tables to the class, no data members, so its layout is the
// one the library was compiled with.
#define LIBRAW_LIBRARY_BUILD
#include "libraw/libraw.h"

#include <atomic>
#include <cstdlib>
#include <exception>
#include <thread>
#include <vector>

// LibRaw keeps its processing-step callbacks protected and offers no C
// setter. A pointer to the member taken through a derived class reaches
// them without changing the vendored tree.
namespace {
struct CallbackAccess : LibRaw {
    static libraw_callbacks_t &of(LibRaw *raw) { return raw->*(&CallbackAccess::callbacks); }
};

// The stage 3 pass the Rust side hands over: one function for every
// handle, set before the first develop that wants it.
void (*heeler_stage3_fn)(libraw_data_t *) = nullptr;

void heeler_pre_rgb(void *ctx) {
    if (ctx && heeler_stage3_fn) heeler_stage3_fn(&static_cast<LibRaw *>(ctx)->imgdata);
}
// The Bayer develop's AHD demosaic across the machine's cores. LibRaw's
// ahd_interpolate works in independent 512-pixel tiles, one buffer a
// worker, and shares only the per-handle color tables (tls->ahd_data,
// read-only once cielab has built them); its OpenMP build runs the tile
// rows in parallel the same way. Heeler builds LibRaw without OpenMP,
// so this runs LibRaw's own four tile steps from plain threads instead,
// each worker with its own zeroed buffer as malloc_omp_buffers gives.
struct AhdAccess : LibRaw {
    using Rgb = ushort (*)[LIBRAW_AHD_TILE][LIBRAW_AHD_TILE][3];
    using Lab = short (*)[LIBRAW_AHD_TILE][LIBRAW_AHD_TILE][3];
    using Homo = char (*)[LIBRAW_AHD_TILE][2];
    static void setup(LibRaw *r) {
        (r->*(&AhdAccess::cielab))(nullptr, nullptr);
        (r->*(&AhdAccess::border_interpolate))(5);
    }
    static void tile(LibRaw *r, int top, int left, Rgb rgb, Lab lab, Homo homo) {
        (r->*(&AhdAccess::ahd_interpolate_green_h_and_v))(top, left, rgb);
        (r->*(&AhdAccess::ahd_interpolate_r_and_b_and_convert_to_cielab))(top, left, rgb, lab);
        (r->*(&AhdAccess::ahd_interpolate_build_homogeneity_map))(top, left, lab, homo);
        (r->*(&AhdAccess::ahd_interpolate_combine_homogeneous_pixels))(top, left, rgb, homo);
    }
    static int fuji_width(LibRaw *r) { return (r->*(&AhdAccess::libraw_internal_data)).internal_output_params.fuji_width; }
};

std::atomic<int> heeler_ahd_threads_wanted(0);
const size_t AHD_BUFFER = 26 * size_t(LIBRAW_AHD_TILE) * LIBRAW_AHD_TILE;

void heeler_ahd_parallel(void *ctx) {
    LibRaw *r = static_cast<LibRaw *>(ctx);
    const int height = r->imgdata.sizes.height, width = r->imgdata.sizes.width;
    AhdAccess::setup(r);
    std::vector<int> tops;
    for (int top = 2; top < height - 5; top += LIBRAW_AHD_TILE - 6) tops.push_back(top);
    int wanted = heeler_ahd_threads_wanted;
    unsigned cores = std::thread::hardware_concurrency();
    size_t n = wanted > 0 ? size_t(wanted) : (cores == 0 ? 1 : cores);
    n = n < tops.size() ? n : tops.size();
    if (n == 0) return;
    std::atomic<size_t> next(0);
    // 0 running, 1 canceled by the progress callback, 2 out of memory,
    // 3 a tile step threw.
    std::atomic<int> stop(0);
    libraw_callbacks_t &cb = CallbackAccess::of(r);
    auto work = [&]() {
        char *buffer = static_cast<char *>(calloc(AHD_BUFFER, 1));
        if (!buffer) {
            stop = 2;
            return;
        }
        auto rgb = reinterpret_cast<AhdAccess::Rgb>(buffer);
        auto lab = reinterpret_cast<AhdAccess::Lab>(buffer + 12 * LIBRAW_AHD_TILE * LIBRAW_AHD_TILE);
        auto homo = reinterpret_cast<AhdAccess::Homo>(buffer + 24 * LIBRAW_AHD_TILE * LIBRAW_AHD_TILE);
        try {
            for (;;) {
                size_t i = next++;
                if (i >= tops.size() || stop) break;
                int top = tops[i];
                if (cb.progress_cb && (*cb.progress_cb)(cb.progresscb_data, LIBRAW_PROGRESS_INTERPOLATE, top - 2, height - 7)) {
                    stop = 1;
                    break;
                }
                for (int left = 2; left < width - 5; left += LIBRAW_AHD_TILE - 6) AhdAccess::tile(r, top, left, rgb, lab, homo);
            }
        } catch (...) {
            stop = 3;
        }
        free(buffer);
    };
    std::vector<std::thread> workers;
    for (size_t t = 1; t < n; t++) workers.emplace_back(work);
    work();
    for (auto &t : workers) t.join();
    if (stop == 1) throw LIBRAW_EXCEPTION_CANCELLED_BY_CALLBACK;
    if (stop == 2) throw LIBRAW_EXCEPTION_ALLOC;
    if (stop == 3) throw LIBRAW_EXCEPTION_IO_CORRUPT;
}

// Run right before dcraw_process picks its demosaic, after pre_interpolate
// has settled the filters and colors: the same test dcraw_process makes,
// and the parallel AHD put in only where it would have run
// ahd_interpolate (quality 3: the default for every camera but a
// Fujifilm SuperCCD, or asked for). Everything else keeps LibRaw's path.
void heeler_choose_demosaic(void *ctx) {
    LibRaw *r = static_cast<LibRaw *>(ctx);
    libraw_callbacks_t &cb = CallbackAccess::of(r);
    cb.interpolate_bayer_cb = nullptr;
    const unsigned filters = r->imgdata.idata.filters;
    if (filters <= 1000 || r->imgdata.params.no_interpolation) return;
    int quality = 2 + !AhdAccess::fuji_width(r);
    if (r->imgdata.params.user_qual >= 0) quality = r->imgdata.params.user_qual;
    int real_colors = r->imgdata.idata.colors;
    int bad_bayer = 0;
    for (int row = 0; row < 4; row++)
        for (int col = 0; col < 8; col++) {
            int c = r->COLOR(row, col) + 1;
            real_colors = c > real_colors ? c : real_colors;
            bad_bayer += (r->FC(row, col) == r->FC(row + 1, col));
            bad_bayer += (r->FC(row, col) == r->FC(row, col + 1));
        }
    if (quality != 3 || r->imgdata.idata.colors > 3 || real_colors > 3 || bad_bayer) return;
    cb.interpolate_bayer_cb = heeler_ahd_parallel;
}
} // namespace

extern "C" {

// How many workers share a full-size Bayer develop's AHD tiles: 0 for the
// machine's cores, 1 for one after another (LibRaw's own path's order).
void heeler_set_ahd_threads(int n) { heeler_ahd_threads_wanted = n < 0 ? 0 : n; }

// Puts the parallel AHD in for this handle's develops where LibRaw would
// run its AHD (heeler_choose_demosaic). Set after open, before processing.
void heeler_use_parallel_ahd(libraw_data_t *d) {
    if (!d || !d->parent_class) return;
    CallbackAccess::of(static_cast<LibRaw *>(d->parent_class)).pre_interpolate_cb = heeler_choose_demosaic;
}

// A full-size Bayer develop's AHD workers' tile buffers at the thread
// count set now, for a file LibRaw cannot open from its header (a GPR,
// which is Bayer).
size_t heeler_ahd_workers_bytes() {
    int wanted = heeler_ahd_threads_wanted;
    unsigned cores = std::thread::hardware_concurrency();
    return (wanted > 0 ? size_t(wanted) : (cores == 0 ? 1 : cores)) * AHD_BUFFER;
}

// The tile buffers a parallel AHD holds beyond the usual workspace, one
// a worker, for admission. Read after open, before processing.
size_t heeler_ahd_extra(libraw_data_t *d) {
    if (!d || d->idata.filters <= 1000 || d->params.half_size) return 0;
    int wanted = heeler_ahd_threads_wanted;
    unsigned cores = std::thread::hardware_concurrency();
    size_t n = wanted > 0 ? size_t(wanted) : (cores == 0 ? 1 : cores);
    return n * AHD_BUFFER;
}

// The finished image's size and layout, and the finished image copied
// straight into the caller's buffer: dcraw_make_mem_image's two steps
// without the whole-frame copy it mallocs between them (290 MB at
// 48 MP, held beside LibRaw's own image while the caller copied it out).
int heeler_mem_image_format(libraw_data_t *d, int *width, int *height, int *colors, int *bps) {
    if (!d || !d->parent_class) return LIBRAW_OUT_OF_ORDER_CALL;
    static_cast<LibRaw *>(d->parent_class)->get_mem_image_format(width, height, colors, bps);
    return LIBRAW_SUCCESS;
}
int heeler_copy_mem_image(libraw_data_t *d, void *scan0, int stride) {
    if (!d || !d->parent_class) return LIBRAW_OUT_OF_ORDER_CALL;
    return static_cast<LibRaw *>(d->parent_class)->copy_mem_image(scan0, stride, 0);
}

unsigned heeler_raw_width(libraw_data_t *d) { return d ? d->sizes.raw_width : 0; }
unsigned heeler_raw_height(libraw_data_t *d) { return d ? d->sizes.raw_height : 0; }

// A scene-linear member must retain the camera's declared white. LibRaw's
// default can replace it with this frame's brightest sample, changing the
// light units across a bracket even with auto-brightening disabled.
void heeler_set_fixed_white(libraw_data_t *d, int value) {
    if (d && value) d->params.adjust_maximum_thr = 0.0f;
}

// Whether the file is sensor data the develop has to interpolate: a
// color filter array (Bayer or X-Trans, filters != 0) or a monochrome
// sensor (one color). A linear DNG (already demosaiced: a Heeler bake,
// a merge or denoise another program wrote) is neither, and capture
// sharpening must not be applied to it a second time. Read after
// open, before processing, which rewrites filters for half-size.
int heeler_is_sensor_data(libraw_data_t *d) {
    if (!d) return 0;
    return d->idata.filters != 0 || d->idata.colors == 1;
}

// What a full-size X-Trans develop holds beyond the usual workspace:
// the finished-pixel buffer the patched xtrans_interpolate keeps
// (src/demosaic/xtrans_demosaic.cpp, three shorts a pixel) and one
// tile buffer per worker. Read after open, before processing.
int heeler_xtrans_threads();
size_t heeler_xtrans_extra(libraw_data_t *d) {
    if (!d || d->idata.filters != 9 || d->params.half_size) return 0;
    size_t pixels = size_t(d->sizes.width) * d->sizes.height;
    size_t tile = size_t(LIBRAW_AHD_TILE) * LIBRAW_AHD_TILE * 94;
    return pixels * 6 + size_t(heeler_xtrans_threads()) * tile;
}


void heeler_set_half_size(libraw_data_t *d, int value) {
    if (d) d->params.half_size = value;
}

// As-shot white balance from the camera. LibRaw's default multipliers
// ignore what the camera metered, which shifts every develop green/cold.
void heeler_set_use_camera_wb(libraw_data_t *d, int value) {
    if (d) d->params.use_camera_wb = value;
}

// The camera's embedded color matrix (sensor RGB -> output primaries).
// Off falls back to LibRaw's adobe_coeff table.
// LibRaw's highlight handling (params.highlight): 0 clips at sensor
// saturation, 2 blends the clipped channel from the unclipped ones,
// 3..9 rebuild with increasing chroma rolloff. 1 (unclipped) is not
// offered: unrolled super-white data through an sRGB export is the
// failure the output encoding must guard against.
void heeler_set_highlight(libraw_data_t *d, int value) {
    if (d) d->params.highlight = value;
}

void heeler_set_use_camera_matrix(libraw_data_t *d, int value) {
    if (d) d->params.use_camera_matrix = value;
}

static void heeler_null_data_cb(void *, const char *, const INT64) {}

// Demosaic algorithm (params.user_qual): -1 leaves LibRaw's default
// (AHD-class), 0 is linear interpolation (fast previews), 11 is DHT,
// the slow high-quality option that resolves high-ISO detail best.
void heeler_set_user_qual(libraw_data_t *d, int value) {
    if (d) d->params.user_qual = value;
}

// The white-balance headroom LibRaw withholds when highlight >= 2:
// with reconstruction on, channels are scaled so the LARGEST camera
// multiplier still fits below white, which darkens the whole frame by
// max(cam_mul)/min-normalized. The caller multiplies it back so
// switching reconstruction modes never reads as an exposure change.
float heeler_wb_headroom(libraw_data_t *d) {
    if (!d) return 1.0f;
    float mn = 0.0f, mx = 0.0f;
    for (int c = 0; c < 4; c++) {
        float v = d->color.pre_mul[c];
        if (v <= 0.0f) continue;
        if (mn == 0.0f || v < mn) mn = v;
        if (v > mx) mx = v;
    }
    if (mn <= 0.0f || mx <= 0.0f) return 1.0f;
    return mx / mn;
}

void heeler_silence_data_errors(libraw_data_t *d) {
    libraw_set_dataerror_handler(d, heeler_null_data_cb, nullptr);
}

// What a DNG's GainMap opcodes need (src/gain_map.rs), read after
// unpack and before processing: the OpcodeList2 bytes LibRaw kept for
// the main image, the single-plane sensor buffer with its pitch, and
// where the stage 2 image (the active area) sits in it.
const unsigned char *heeler_opcode_list2(libraw_data_t *d, size_t *len) {
    if (!d || !d->color.dng_levels.rawopcodes[1].data) { if (len) *len = 0; return nullptr; }
    *len = d->color.dng_levels.rawopcodes[1].len;
    return (const unsigned char *)d->color.dng_levels.rawopcodes[1].data;
}
unsigned short *heeler_cfa_image(libraw_data_t *d) { return d ? d->rawdata.raw_image : nullptr; }
unsigned heeler_raw_pitch(libraw_data_t *d) { return d ? d->sizes.raw_pitch : 0; }
unsigned heeler_top_margin(libraw_data_t *d) { return d ? d->sizes.top_margin : 0; }
unsigned heeler_left_margin(libraw_data_t *d) { return d ? d->sizes.left_margin : 0; }
unsigned heeler_active_width(libraw_data_t *d) { return d ? d->sizes.width : 0; }
unsigned heeler_active_height(libraw_data_t *d) { return d ? d->sizes.height : 0; }
unsigned heeler_filters(libraw_data_t *d) { return d ? d->idata.filters : 0; }

// OpcodeList3 runs after demosaic (src/gain_map.rs apply_rgb): `stage3`
// is called with the handle between LibRaw's demosaic and its color
// conversion, when image holds the camera's colors, black subtracted
// and white balanced, iwidth by iheight, four samples a pixel.
void heeler_use_stage3_opcodes(libraw_data_t *d, void (*stage3)(libraw_data_t *)) {
    if (!d || !d->parent_class) return;
    heeler_stage3_fn = stage3;
    CallbackAccess::of(static_cast<LibRaw *>(d->parent_class)).pre_converttorgb_cb = heeler_pre_rgb;
}
const unsigned char *heeler_opcode_list3(libraw_data_t *d, size_t *len) {
    if (!d || !d->color.dng_levels.rawopcodes[2].data) { if (len) *len = 0; return nullptr; }
    *len = d->color.dng_levels.rawopcodes[2].len;
    return (const unsigned char *)d->color.dng_levels.rawopcodes[2].data;
}
unsigned short *heeler_rgb_image(libraw_data_t *d) { return d && d->image ? &d->image[0][0] : nullptr; }
unsigned heeler_iwidth(libraw_data_t *d) { return d ? d->sizes.iwidth : 0; }
unsigned heeler_iheight(libraw_data_t *d) { return d ? d->sizes.iheight : 0; }
int heeler_colors(libraw_data_t *d) { return d ? d->idata.colors : 0; }

// The black level LibRaw will subtract at (row, col) of the active
// area, as copy_bayer will: the common level, the per-color level of
// the CFA site, and the repeating BlackLevel pattern. adjust_bl moves
// amounts between these three before subtracting, but not their sum.
// Bayer layouts only (filters > 1000); the pattern repeats every
// heeler_black_period rows and columns.
unsigned heeler_black_at(libraw_data_t *d, unsigned row, unsigned col) {
    if (!d) return 0;
    const libraw_colordata_t &c = d->color;
    unsigned filters = d->idata.filters;
    unsigned site = (filters >> ((((row << 1) & 14) | (col & 1)) << 1)) & 3;
    unsigned black = c.black + c.cblack[site];
    if (c.cblack[4] && c.cblack[5] && 6 + c.cblack[4] * c.cblack[5] <= LIBRAW_CBLACK_SIZE)
        black += c.cblack[6 + (row % c.cblack[4]) * c.cblack[5] + col % c.cblack[5]];
    return black;
}
void heeler_black_period(libraw_data_t *d, unsigned *rows, unsigned *cols) {
    unsigned r = 1, k = 1;
    if (d && d->color.cblack[4] && d->color.cblack[5]) { r = d->color.cblack[4]; k = d->color.cblack[5]; }
    // The CFA site repeats every 8 rows and 2 columns in a Bayer
    // filters word; the pattern every r by k.
    unsigned a = 8, b = 2;
    while (a % r) a += 8;
    while (b % k) b += 2;
    *rows = a; *cols = b;
}

} // extern "C"
