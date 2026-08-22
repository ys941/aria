"""Audio decoding helpers.

We shell out to ffmpeg so we can ingest *anything* (wav, mp3, flac, ogg, m4a)
and always get back mono 16-bit PCM at LiveKit's preferred 48 kHz — no
per-format branching, no resampling surprises.
"""
import asyncio
import glob
import os
import shutil

import numpy as np

SAMPLE_RATE = 48000
NUM_CHANNELS = 1


def _find_ffmpeg() -> str:
    """Locate ffmpeg robustly — PATH is unreliable on Windows when ffmpeg was
    installed via winget (no PATH shim) or after the server process started.
    Override with the FFMPEG_BIN env var if needed."""
    env = os.environ.get("FFMPEG_BIN")
    if env and os.path.exists(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    # Windows winget (Gyan.FFmpeg) drops the binary deep under LOCALAPPDATA.
    base = os.environ.get("LOCALAPPDATA", "")
    if base:
        for pat in ("Gyan.FFmpeg*", "*FFmpeg*", "*ffmpeg*"):
            hits = glob.glob(
                os.path.join(base, "Microsoft", "WinGet", "Packages", pat, "**", "ffmpeg.exe"),
                recursive=True,
            )
            if hits:
                return hits[0]
    return "ffmpeg"  # last resort — let it fail loudly if truly absent


FFMPEG = _find_ffmpeg()


async def decode_to_pcm(path: str, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decode `path` to a 1-D int16 numpy array (mono, `sample_rate` Hz)."""
    proc = await asyncio.create_subprocess_exec(
        FFMPEG,
        "-v", "error",
        "-i", str(path),
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "-ac", str(NUM_CHANNELS),
        "-ar", str(sample_rate),
        "-",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed decoding {path}: {err.decode(errors='ignore')}")
    return np.frombuffer(out, dtype=np.int16).copy()
