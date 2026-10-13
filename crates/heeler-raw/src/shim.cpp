// Small C shim over LibRaw internals the C API does not expose.
//
// - heeler_set_half_size: params.half_size skips demosaic interpolation and
//   returns a half-resolution develop (~4x faster). Preview rendering uses
//   it; export-quality decodes leave it off.
// - heeler_silence_data_errors: LibRaw's default data-error callback prints
//   "unknown file: data corrupted at N" to stderr for recoverable warnings
//   (Panasonic S5 II files trip it on every decode). Route it to a no-op;
//   real failures still surface through return codes.

#include "libraw/libraw.h"

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
} // namespace

extern "C" {

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
