// The one call Heeler makes into GoPro's VC-5 decoder (third_party/gpr-vc5),
// in plain C so the Rust side sees two functions and no structs. It does
// what the GPR SDK's own reader does for a GPR's raw tile
// (gpr_read_image.cpp, DecodeVC5): an RGGB sensor decodes as 14-bit
// samples, any other as GBRG 12-bit, each in 16 bits, row after row.

#include <stdint.h>
#include <stdlib.h>

#include "vc5_decoder.h"

static void *heeler_vc5_alloc(size_t size) { return malloc(size); }
static void heeler_vc5_release(void *block) { free(block); }

// 0 on success, with *out holding *out_len bytes the caller frees with
// heeler_vc5_free. Anything else is the decoder's error code, and nothing
// is left to free. width and height are the DNG's: a bitstream that names
// another size is refused before it sizes an allocation.
int heeler_vc5_decode(const void *data, size_t len, int rggb, int width, int height, void **out, size_t *out_len)
{
    vc5_decoder_parameters params;
    vc5_decoder_parameters_set_default(&params);
    params.mem_alloc = heeler_vc5_alloc;
    params.mem_free = heeler_vc5_release;
    params.pixel_format = rggb ? VC5_DECODER_PIXEL_FORMAT_RGGB_14 : VC5_DECODER_PIXEL_FORMAT_GBRG_12;
    params.expected_width = width;
    params.expected_height = height;

    gpr_buffer input = { (void *)data, len };
    gpr_buffer raw = { NULL, 0 };
    CODEC_ERROR error = vc5_decoder_process(&params, &input, &raw, NULL);
    if (error != CODEC_ERROR_OKAY) {
        // The decoder releases what it allocated before it returns an error.
        return (int)error;
    }
    *out = raw.buffer;
    *out_len = raw.size;
    return 0;
}

void heeler_vc5_free(void *block) { free(block); }
