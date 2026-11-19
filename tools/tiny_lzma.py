"""Build an LZMA payload and its inline MIT-licensed browser decoder.

Give compress_lzma() the same bytes that the gzip packer accepts. Insert
inline_lzma(esbuild) before the HTML bootstrap and read the uncompressed bytes
with decodeLzma(data.subarray(0, n)). The existing HTML byte quoting still
applies to the result of compress_lzma().

The decoder is adapted from Juan Mellado's js-lzma at commit
3060ba8a5b5e6f4e7276d937b5e214979bf9f52b:
https://github.com/jcmellado/js-lzma/tree/3060ba8a5b5e6f4e7276d937b5e214979bf9f52b
"""

import lzma
from pathlib import Path
import struct
import subprocess


DECODER = Path(__file__).resolve().parents[1] / 'tiny'
DICTIONARY_SIZE = 1 << 19
MAX_PAYLOAD_SIZE = 1 << 22


def compress_lzma(payload):
    if len(payload) > MAX_PAYLOAD_SIZE:
        raise ValueError('LZMA payload exceeds the browser decoder limit')
    compressed = lzma.compress(
        payload,
        format=lzma.FORMAT_ALONE,
        filters=[{
            'id': lzma.FILTER_LZMA1,
            'preset': 9 | lzma.PRESET_EXTREME,
            'dict_size': DICTIONARY_SIZE,
            'lc': 1,
            'lp': 0,
            'pb': 0,
        }],
    )
    # Supply the expanded size in the .lzma header for exact output allocation.
    return compressed[:5] + struct.pack('<Q', len(payload)) + compressed[13:]


def inline_lzma(esbuild):
    # Underscore-prefixed properties belong to the vendored decoder.
    minified = subprocess.run(
        [esbuild, '--target=es2022', '--minify', '--mangle-props=^_', '--log-level=error'],
        input=(DECODER / 'lzma.js').read_bytes(),
        stdout=subprocess.PIPE,
        check=True,
    ).stdout
    notice = (DECODER / 'lzma.LICENSE.txt').read_bytes()
    return b'/*\n' + notice + b'*/\n' + minified
