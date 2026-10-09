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

} // extern "C"
