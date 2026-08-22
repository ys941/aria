"""Runtime configuration, sourced from the environment (.env supported)."""
import os
import pathlib

from dotenv import load_dotenv

# Load the project's .env explicitly so it works regardless of the process CWD
# (e.g. when the server is launched from another directory by a preview/launcher).
load_dotenv(pathlib.Path(__file__).resolve().parent.parent / ".env")

# LiveKit dev server defaults (livekit-server --dev): key=devkey secret=secret.
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")

# The single room the podcast happens in (one per session is plenty for now).
ROOM_NAME = os.environ.get("REACHY_ROOM", "reachy-podcast")

# Where pre-rendered / sample audio clips live (the TTS stage will drop files here).
import pathlib

SAMPLES_DIR = pathlib.Path(
    os.environ.get("REACHY_SAMPLES_DIR", pathlib.Path(__file__).parent.parent / "samples")
).resolve()

# Token for the /admin control panel (stop shows on demand). Unset = admin off.
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

# Modal-hosted brain + voice (llama.cpp Nemotron + Qwen3-TTS) — used as a
# fallback when the cloud providers below aren't configured.
MODAL_LLM_URL = os.environ.get("MODAL_LLM_URL", "").rstrip("/")
MODAL_LLM_KEY = os.environ.get("MODAL_LLM_KEY", "")
MODAL_TTS_URL = os.environ.get("MODAL_TTS_URL", "").rstrip("/")
MODAL_TTS_KEY = os.environ.get("MODAL_TTS_KEY", "")

# Preferred cloud providers (no cold start, high rate limits):
#   brain  -> Google Gemini via its OpenAI-compatible endpoint
#   voices -> Groq Orpheus TTS
# When a key is set, that provider is used instead of the Modal equivalent.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_TTS_MODEL = os.environ.get("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english")
# Groq also hosts LLMs — the same key writes the show scripts (primary brain).
GROQ_LLM_MODEL = os.environ.get("GROQ_LLM_MODEL", "llama-3.3-70b-versatile")

# xAI Grok (OpenAI-compatible) — optional FALLBACK brain, used automatically when
# Gemini errors or rate-limits. Brain order: Gemini -> xAI Grok -> Modal.
XAI_API_KEY = os.environ.get("XAI_API_KEY", "")
XAI_MODEL = os.environ.get("XAI_MODEL", "grok-3")
