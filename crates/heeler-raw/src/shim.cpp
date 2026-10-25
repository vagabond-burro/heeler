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

// What heeler-raw's own decoder for linear DNGs (linear_dng.rs) needs
// from LibRaw's open of a file: the sizes, the tiles, the levels, the
// white balance and matrix it develops with, the settings that steer
// dcraw_process, and two tables: the linearization LibRaw applies as it
// loads each sample (imgdata.color.curve after open) and the output
// curve copy_mem_image writes through (gamma_curve's mode 2 at the
// white copy_mem_image takes without auto-brightening). Read after open,
// before unpack. Answers 0 when the handle is not open.
struct HeelerLinear {
    unsigned raw_width, raw_height, width, height, top_margin, left_margin;
    int flip;
    unsigned filters;
    int colors;
    unsigned tiff_samples, tiff_bps, tiff_compress, tile_width, tile_length;
    unsigned raw_color, zero_is_bad, fuji_width, is_foveon, lossless_dng;
    unsigned maximum, black;
    unsigned cblack[6];
    unsigned dng_version;
    int as_shot_wb_applied;
    float pixel_aspect;
    float cam_mul[4], pre_mul[4];
    float rgb_cam[3][4];
    unsigned short white[8][8];
    float user_mul[4];
    int use_auto_wb, use_camera_wb, highlight, user_black, user_cblack[4], user_sat, med_passes;
    int no_auto_scale, green_matching, exp_correc, no_interpolation, has_bad_pixels, has_dark_frame, cropbox_set, half_size;
    int output_color, output_bps, four_color_rgb, use_fuji_rotate;
    float threshold, adjust_maximum_thr, bright;
    double aber[4];
    double gamm[6];
};
struct LinearAccess : LibRaw {
    static libraw_internal_data_t &internal(LibRaw *r) { return r->*(&LinearAccess::libraw_internal_data); }
    static bool lossless(LibRaw *r) { return (r->*(&LinearAccess::load_raw)) == &LinearAccess::lossless_dng_load_raw; }
    static void gamma(LibRaw *r, double pwr, double ts, int mode, int imax) { (r->*(&LinearAccess::gamma_curve))(pwr, ts, mode, imax); }
};
int heeler_linear_facts(libraw_data_t *d, HeelerLinear *f, unsigned short *lintable, unsigned short *outcurve) {
    if (!d || !d->parent_class || !f) return 0;
    LibRaw *r = static_cast<LibRaw *>(d->parent_class);
    libraw_internal_data_t &in = LinearAccess::internal(r);
    const libraw_colordata_t &C = d->color;
    const libraw_output_params_t &O = d->params;
    f->raw_width = d->sizes.raw_width; f->raw_height = d->sizes.raw_height;
    f->width = d->sizes.width; f->height = d->sizes.height;
    f->top_margin = d->sizes.top_margin; f->left_margin = d->sizes.left_margin;
    f->flip = d->sizes.flip; f->filters = d->idata.filters; f->colors = d->idata.colors;
    f->tiff_samples = in.unpacker_data.tiff_samples; f->tiff_bps = in.unpacker_data.tiff_bps;
    f->tiff_compress = in.unpacker_data.tiff_compress;
    f->tile_width = in.unpacker_data.tile_width; f->tile_length = in.unpacker_data.tile_length;
    f->raw_color = in.internal_output_params.raw_color; f->zero_is_bad = in.internal_output_params.zero_is_bad;
    f->fuji_width = in.internal_output_params.fuji_width; f->is_foveon = d->idata.is_foveon;
    f->lossless_dng = LinearAccess::lossless(r);
    f->maximum = C.maximum; f->black = C.black;
    for (int i = 0; i < 6; i++) f->cblack[i] = C.cblack[i];
    f->dng_version = d->idata.dng_version; f->as_shot_wb_applied = C.as_shot_wb_applied;
    f->pixel_aspect = float(d->sizes.pixel_aspect);
    for (int i = 0; i < 4; i++) { f->cam_mul[i] = C.cam_mul[i]; f->pre_mul[i] = C.pre_mul[i]; f->user_mul[i] = O.user_mul[i]; f->user_cblack[i] = O.user_cblack[i]; f->aber[i] = O.aber[i]; }
    for (int i = 0; i < 3; i++) for (int j = 0; j < 4; j++) f->rgb_cam[i][j] = C.rgb_cam[i][j];
    for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) f->white[i][j] = C.white[i][j];
    f->use_auto_wb = O.use_auto_wb; f->use_camera_wb = O.use_camera_wb; f->highlight = O.highlight;
    f->user_black = O.user_black; f->user_sat = O.user_sat; f->med_passes = O.med_passes;
    f->no_auto_scale = O.no_auto_scale; f->green_matching = O.green_matching; f->exp_correc = O.exp_correc;
    f->no_interpolation = O.no_interpolation; f->has_bad_pixels = O.bad_pixels != nullptr; f->has_dark_frame = O.dark_frame != nullptr;
    f->cropbox_set = (~O.cropbox[2] && ~O.cropbox[3]) ? 1 : 0; f->half_size = O.half_size;
    f->output_color = O.output_color; f->output_bps = O.output_bps; f->four_color_rgb = O.four_color_rgb; f->use_fuji_rotate = O.use_fuji_rotate;
    f->threshold = O.threshold; f->adjust_maximum_thr = O.adjust_maximum_thr; f->bright = O.bright;
    for (int i = 0; i < 6; i++) f->gamm[i] = O.gamm[i];
    if (lintable) for (int i = 0; i < 0x10000; i++) lintable[i] = C.curve[i];
    if (outcurve) {
        // copy_mem_image's own call: t_white 0x2000 without auto-brightening.
        int t_white = 0x2000;
        LinearAccess::gamma(r, O.gamm[0], O.gamm[1], 2, int((t_white << 3) / O.bright));
        for (int i = 0; i < 0x10000; i++) outcurve[i] = d->color.curve[i];
        // The linearization table is the curve LibRaw loads through: put
        // it back, so the handle could still be unpacked as opened.
        if (lintable) for (int i = 0; i < 0x10000; i++) d->color.curve[i] = lintable[i];
    }
    return 1;
}

// The develop's working image at three points, for the tests that hold
// linear_dng.rs to LibRaw's develop step by step: as loaded (before the
// black level), as scaled (before pre_interpolate), and before the
// conversion to RGB; with the white level and data maximum before the
// scale and the white-balance multipliers after it. Installed on a
// handle that is about to be processed, which its own pre_converttorgb
// stage then leaves to this capture.
struct LinearCapture {
    unsigned short *loaded, *scaled, *before_rgb;
    size_t pixels;
    unsigned *maxima;
    float *pre_mul;
    float *rgb_cam;
};
thread_local LinearCapture heeler_capture = {};
void heeler_capture_into(LibRaw *r, unsigned short *to) {
    size_t n = size_t(r->imgdata.sizes.iheight) * r->imgdata.sizes.iwidth;
    if (!to || n > heeler_capture.pixels || !r->imgdata.image) return;
    for (size_t i = 0; i < n * 4; i++) to[i] = (&r->imgdata.image[0][0])[i];
}
void heeler_capture_loaded(void *ctx) {
    LibRaw *r = static_cast<LibRaw *>(ctx);
    heeler_capture_into(r, heeler_capture.loaded);
    if (heeler_capture.maxima) {
        heeler_capture.maxima[0] = r->imgdata.color.maximum;
        heeler_capture.maxima[1] = r->imgdata.color.data_maximum;
    }
}
void heeler_capture_scaled(void *ctx) {
    LibRaw *r = static_cast<LibRaw *>(ctx);
    heeler_capture_into(r, heeler_capture.scaled);
    if (heeler_capture.pre_mul) for (int c = 0; c < 4; c++) heeler_capture.pre_mul[c] = r->imgdata.color.pre_mul[c];
    if (heeler_capture.maxima) heeler_capture.maxima[2] = r->imgdata.color.maximum;
}
void heeler_capture_before_rgb(void *ctx) {
    LibRaw *r = static_cast<LibRaw *>(ctx);
    heeler_capture_into(r, heeler_capture.before_rgb);
    if (heeler_capture.rgb_cam) for (int i = 0; i < 3; i++) for (int j = 0; j < 4; j++) heeler_capture.rgb_cam[i * 4 + j] = r->imgdata.color.rgb_cam[i][j];
}
void heeler_linear_capture(libraw_data_t *d, unsigned short *loaded, unsigned short *scaled, unsigned short *before_rgb, size_t pixels, unsigned *maxima, float *pre_mul, float *rgb_cam) {
    if (!d || !d->parent_class) return;
    heeler_capture = LinearCapture{loaded, scaled, before_rgb, pixels, maxima, pre_mul, rgb_cam};
    libraw_callbacks_t &cb = CallbackAccess::of(static_cast<LibRaw *>(d->parent_class));
    cb.pre_scalecolors_cb = heeler_capture_loaded;
    cb.pre_preinterpolate_cb = heeler_capture_scaled;
    cb.pre_converttorgb_cb = heeler_capture_before_rgb;
}

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

// What a DNG's GainMap opcodes need (heeler-rawdec's gain_map), read after
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
// A new image area's size, from the same top left, after open.
void heeler_set_area(libraw_data_t *d, unsigned width, unsigned height) {
    if (d) { d->sizes.width = width; d->sizes.height = height; }
}

// OpcodeList3 runs after demosaic (heeler-rawdec's gain_map, apply_rgb): `stage3`
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
// The camera LibRaw names an open file's writer, for the harnesses that
// hold heeler-rawdec to LibRaw on files without a header to name it.
const char *heeler_make(libraw_data_t *d) { return d ? d->idata.make : ""; }
const char *heeler_model(libraw_data_t *d) { return d ? d->idata.model : ""; }
// An X-Trans sensor's 6 by 6 colors from the image area's top left.
void heeler_xtrans(libraw_data_t *d, char *out) {
    for (int i = 0; i < 36; i++) out[i] = d ? d->idata.xtrans[i / 6][i % 6] : 0;
}

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
