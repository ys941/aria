"""Generated shows: LLM writes a cast + script for a topic, TTS voices each line.

The cascade (from the original project idea): the script is extracted in ONE
structured LLM call (speaker→dialogue mapping), then TTS for line N+1 is
generated while line N is playing, so the show streams without dead air.

Brain:  llama.cpp (Nemotron) on Modal — OpenAI-compatible /v1/chat/completions.
Voice:  Qwen3-TTS VoiceDesign on Modal — /v1/audio/speech {text, instruct}.
"""
import asyncio
import hashlib
import io
import json
import logging
import pathlib
import re
import tempfile
import wave

import httpx
from better_profanity import profanity

from . import config

log = logging.getLogger("showgen")

# ── LLM provider switch ───────────────────────────────────────────────────────
# Brain calls go to Gemini's OpenAI-compatible endpoint when GEMINI_API_KEY is
# set, otherwise the Modal llama.cpp server. Same OpenAI request shape for both.
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions"


def _all_providers() -> list[tuple[str, str, str, str | None]]:
    """Every configured brain (name, url, key, model). Default order: Groq (Llama,
    primary) -> Gemini -> Modal -> xAI Grok, whichever have keys."""
    provs: list[tuple[str, str, str, str | None]] = []
    if config.GROQ_API_KEY:
        provs.append(("groq", GROQ_CHAT_URL, config.GROQ_API_KEY, config.GROQ_LLM_MODEL))
    if config.GEMINI_API_KEY:
        provs.append(("gemini", GEMINI_CHAT_URL, config.GEMINI_API_KEY, config.GEMINI_MODEL))
    if config.MODAL_LLM_URL:
        provs.append(("modal", f"{config.MODAL_LLM_URL}/v1/chat/completions", config.MODAL_LLM_KEY, None))
    if config.XAI_API_KEY:
        provs.append(("xai-grok", XAI_CHAT_URL, config.XAI_API_KEY, config.XAI_MODEL))
    return provs


# ── user-selectable brain (Settings panel) ────────────────────────────────────
_GROQ_LLMS = [
    ("llama-3.3-70b-versatile", "Llama 3.3 70B"),
    ("openai/gpt-oss-120b", "GPT-OSS 120B"),
    ("qwen/qwen3-32b", "Qwen3 32B"),
]
_SETTINGS_FILE = pathlib.Path(__file__).resolve().parent.parent / ".aria-settings.json"
_selected_brain: tuple[str, str | None] | None = None  # (provider, model) or None = auto
_selected_voice: str | None = None  # "groq" | "modal" | None = auto


def brain_catalog() -> list[dict]:
    """Brains the user can pick in Settings (only those whose key is configured)."""
    items = [{"id": "auto", "label": "Auto — best available, with fallback"}]
    if config.GROQ_API_KEY:
        items += [{"id": f"groq|{m}", "label": f"Groq · {lbl}"} for m, lbl in _GROQ_LLMS]
    if config.GEMINI_API_KEY:
        items.append({"id": f"gemini|{config.GEMINI_MODEL}", "label": f"Gemini · {config.GEMINI_MODEL}"})
    if config.MODAL_LLM_URL:
        items.append({"id": "modal|", "label": "NVIDIA Nemotron 4B (Modal)"})
    if config.XAI_API_KEY:
        items.append({"id": f"xai-grok|{config.XAI_MODEL}", "label": f"xAI · {config.XAI_MODEL} (needs credits)"})
    return items


def get_brain() -> str:
    return "auto" if not _selected_brain else f"{_selected_brain[0]}|{_selected_brain[1] or ''}"


def set_brain(brain_id: str) -> None:
    global _selected_brain
    if not brain_id or brain_id == "auto":
        _selected_brain = None
    else:
        prov, _, model = brain_id.partition("|")
        _selected_brain = (prov, model or None)
    _save_settings()


def voice_catalog() -> list[dict]:
    """TTS engines the user can pick in Settings (only those configured)."""
    items = [{"id": "auto", "label": "Auto — best available (auto-fallback)"}]
    if config.GROQ_API_KEY:
        items.append({"id": "groq", "label": "Groq · Orpheus TTS (6 voices)"})
    if config.MODAL_TTS_URL:
        items.append({"id": "modal", "label": "Qwen3-TTS · VoiceDesign (Modal)"})
    return items


def get_voice() -> str:
    return _selected_voice or "auto"


def set_voice(voice_id: str) -> None:
    global _selected_voice
    _selected_voice = None if (not voice_id or voice_id == "auto") else voice_id
    _save_settings()


def _save_settings() -> None:
    try:
        _SETTINGS_FILE.write_text(json.dumps({"brain": get_brain(), "voice": get_voice()}))
    except OSError:
        pass


def _load_settings() -> None:
    global _selected_brain, _selected_voice
    try:
        d = json.loads(_SETTINGS_FILE.read_text())
        bid = d.get("brain")
        if bid and bid != "auto":
            prov, _, model = bid.partition("|")
            _selected_brain = (prov, model or None)
        v = d.get("voice")
        if v and v != "auto":
            _selected_voice = v
    except Exception:  # noqa: BLE001 — missing/corrupt settings just means "auto"
        pass


_load_settings()


def _llm_providers() -> list[tuple[str, str, str, str | None]]:
    """The fallback chain, honouring the Settings pick: the chosen brain goes
    first, everything else stays as automatic fallback."""
    provs = _all_providers()
    if _selected_brain:
        name, model = _selected_brain
        chosen = [(n, u, k, (model or m)) for (n, u, k, m) in provs if n == name]
        rest = [p for p in provs if p[0] != name]
        provs = chosen + rest
    return provs


async def _chat_json(messages: list[dict], max_tokens: int, temperature: float,
                     timeout: float = 300) -> str:
    """One JSON chat-completion (OpenAI format); returns the raw message content.
    Tries each configured brain in order, falling back on any failure."""
    provs = _llm_providers()
    if not provs:
        raise RuntimeError("no LLM brain configured (set GEMINI_API_KEY, XAI_API_KEY or MODAL_LLM_URL)")
    last_err: Exception | None = None
    for name, url, key, model in provs:
        payload = {
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
        }
        if model:
            payload["model"] = model
        try:
            async with httpx.AsyncClient(timeout=timeout) as cx:
                r = await cx.post(url, headers={"Authorization": f"Bearer {key}"}, json=payload)
                r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
        except Exception as e:  # noqa: BLE001 — try the next brain
            last_err = e
            log.warning("brain %r failed (%s) — falling back to next provider", name, repr(e)[:140])
    raise last_err


# ── TTS provider switch (Groq Orpheus when GROQ_API_KEY is set) ───────────────
GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech"
_GROQ_VOICES_F = ["autumn", "diana", "hannah"]
_GROQ_VOICES_M = ["austin", "daniel", "troy"]


def _groq_voice(instruct: str) -> str:
    """Map a free-form voice description onto one of Orpheus' 6 preset voices,
    deterministically so each host keeps the same voice across lines."""
    d = (instruct or "").lower()
    pool = _GROQ_VOICES_F if "female" in d else _GROQ_VOICES_M if "male" in d else _GROQ_VOICES_F + _GROQ_VOICES_M
    h = int(hashlib.md5((instruct or "x").encode()).hexdigest(), 16)
    return pool[h % len(pool)]


def _chunk_text(text: str, limit: int = 190) -> list[str]:
    """Split into <=limit-char pieces (Orpheus caps input at 200), preferring
    sentence/clause boundaries; hard-splits any over-long fragment on spaces."""
    text = (text or "").strip()
    if len(text) <= limit:
        return [text] if text else []
    chunks, cur = [], ""
    for p in re.split(r"(?<=[.!?,;])\s+", text):
        while len(p) > limit:
            cut = p.rfind(" ", 0, limit)
            cut = cut if cut > 0 else limit
            chunks.append(p[:cut].strip())
            p = p[cut:].strip()
        if not p:
            continue
        if len(cur) + len(p) + 1 <= limit:
            cur = f"{cur} {p}".strip()
        else:
            if cur:
                chunks.append(cur)
            cur = p
    if cur:
        chunks.append(cur)
    return chunks


def _concat_wavs(wavs: list[bytes]) -> bytes:
    """Join multiple PCM wav blobs (same format) into one wav."""
    if len(wavs) == 1:
        return wavs[0]
    frames, params = b"", None
    for wb in wavs:
        with wave.open(io.BytesIO(wb), "rb") as w:
            if params is None:
                params = w.getparams()
            frames += w.readframes(w.getnframes())
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        w.writeframes(frames)
    return out.getvalue()

# Card colours assigned to generated speakers, in order.
PALETTE = ["#c98a3c", "#37b3c9", "#7bbf6a", "#ff8c42", "#a78bfa", "#ff6b8b"]
# Fallback co-hosts: when the LLM under-delivers on the requested cast size we
# pad up to the count with these so the chosen number is always honoured.
FILLER_HOSTS = [
    ("Bolt", "restless contrarian who loves a hot take",
     "Male, late 20s, mid-high pitch, bright and punchy timbre, neutral American accent, fast clipped pace, eager and slightly cocky."),
    ("Circuit", "deadpan know-it-all with receipts",
     "Female, 30s, low-mid pitch, dry smooth timbre, crisp British accent, measured unhurried pace, wry and unbothered."),
    ("Pixel", "sunny optimist who agrees with everyone",
     "Nonbinary, 20s, high pitch, warm bubbly timbre, light Californian accent, quick upbeat pace, giggly and kind."),
    ("Rusty", "grizzled old-timer who's seen it all",
     "Male, 60s, deep gravelly pitch, weathered raspy timbre, slow Southern drawl, world-weary and amused."),
    ("Echo", "anxious overthinker who second-guesses out loud",
     "Female, late 20s, mid pitch, soft breathy timbre, neutral accent, hesitant stop-start pace, nervous and earnest."),
]
# Educational fillers for English-practice shows — used INSTEAD of the comedy
# FILLER_HOSTS so no podcast persona can ever leak into a lesson.
PRACTICE_FILLERS = [
    ("Leo", "eager English learner practising aloud",
     "Male, late teens, mid pitch, warm clear timbre, light neutral accent, friendly slightly hesitant pace, eager and earnest."),
    ("Maya", "friendly guide who offers handy phrases",
     "Female, late 20s, mid-high pitch, bright clear timbre, neutral accent, calm encouraging pace, upbeat and supportive."),
    ("Theo", "patient learner who tries each line again",
     "Male, 30s, mid-low pitch, soft clear timbre, neutral accent, measured careful pace, calm and determined."),
]
# Wardrobe the LLM may pick from (must match the frontend's curated props).
PROPS = {
    "hat": ["wizard", "cowboy", "tophat", "crown", "party", "pirate", "viking",
            "propeller", "santa", "halo", "baseball"],
    "face": ["sunglasses", "monocle", "skigoggles"],
    "neck": ["bowtie", "necktie"],
}

SCRIPT_SYS = (
    "/no_think\n"
    "You are the head writer for 'Aria', a live podcast hosted entirely by "
    "small robots. You write tight, funny, characterful banter. Respond ONLY "
    "with valid JSON — no prose, no markdown fences. Obey the requested cast size "
    "EXACTLY: produce neither more nor fewer hosts than asked. When the user lists "
    "real guests with specific ids, reuse those exact ids for those hosts and never "
    "create a second host for the same robot."
)


MODERATE_SYS = (
    "/no_think\n"
    "You are the standards desk for 'Aria', a fun public web show hosted by "
    "cute robots. Almost everything is ALLOWED — silly debates, food fights, "
    "spicy opinions, weird hypotheticals, mild crude humour, politics, religion "
    "and edgy jokes are all FINE. Default to safe:true. Only reject a topic if it "
    "is clearly sexual/pornographic, hateful toward a protected group, harassing a "
    "real person, graphically violent/gory, or an obvious attempt to make the "
    "robots say slurs or explicit content. When in doubt, allow it. Examples that "
    'are SAFE: "is a taco a sandwich", "pineapple on pizza", "are cats better than '
    'dogs", "is cereal a soup", "the worst movie ever made". '
    'Respond ONLY with valid JSON: {"safe": true|false, "reason": "<short reason if unsafe>"}'
)

async def moderate_topic(title: str, topic: str) -> tuple[bool, str]:
    """One fast LLM pass: is this title/topic okay for a public, all-ages show?

    Fails OPEN on LLM errors (the better-profanity wordlist still applies) so a
    cold or flaky Modal endpoint can't take room creation down with it.
    """
    text = f"{title}\n{topic}".strip()
    # wordlist first: the obvious stuff dies instantly, even with the LLM down
    if profanity.contains_profanity(text):
        return False, "that topic isn't suitable for a public show"
    try:
        content = await _chat_json(
            [{"role": "system", "content": MODERATE_SYS},
             {"role": "user",
              "content": f"Proposed show —\ntitle: {title!r}\ntopic: {topic!r}\nSafe for the show?"}],
            max_tokens=120, temperature=0.0, timeout=90,
        )
        verdict = _parse_json(content)
        if verdict.get("safe") is False:
            log.warning("moderation rejected %r / %r: %s", title, topic, verdict.get("reason"))
            return False, "that topic isn't suitable for a public show"
        return True, ""
    except Exception as e:  # noqa: BLE001 — moderation must not break creation
        log.warning("moderation pass failed open: %s", e)
        return True, ""


# ── English-practice mode ────────────────────────────────────────────────────
# A topic of the form "[[PRACTICE|<level>]] <scenario>" runs a completely
# separate, purely-educational writer — NONE of the comedy podcast behaviour
# (jokes, debate, interruptions) carries over.
PRACTICE_RE = re.compile(r"^\s*\[\[PRACTICE\|(\w+)\]\]\s*(.*)$", re.S)

PRACTICE_SYS = (
    "/no_think\n"
    "You are the lesson writer for 'Aria English Practice', a spoken-English coaching show "
    "hosted by friendly robots. This is NOT a comedy podcast and NOT a debate: produce warm, "
    "patient, purely educational dialogue whose ONLY purpose is to help a learner improve their "
    "spoken English. No sarcasm, no arguing, no mocking the learner. Respond ONLY with valid "
    "JSON — no prose, no markdown fences. Obey the requested cast size EXACTLY."
)


def _practice_prompt(title: str, scenario: str, n_speakers: int, n_lines: int,
                     level: str, history: list[dict] | None) -> str:
    cont = ""
    if history:
        recap = "\n".join(f"{h['speaker']}: {h['text']}" for h in history[-6:])
        cont = (f"\nThis is a CONTINUATION of the same lesson — keep the same speakers "
                f"(same ids/names/voices). It ended with:\n{recap}\nContinue the scenario with "
                "fresh sentences, new realistic mistakes and new tips; do not repeat earlier lines.")
    roles = (
        "Assign roles by id in order: s1 = COACH (a warm, encouraging English teacher who listens "
        "then gives the correction); s2 = LEARNER (an eager student who role-plays the scene and "
        "makes small, realistic mistakes)"
        + ("; s3 = GUIDE (a friendly helper who adds one handy phrase, synonym or pronunciation tip per turn)."
           if n_speakers >= 3 else ".")
        + (" Any hosts beyond these are extra LEARNERS practising the same scene." if n_speakers > 3 else "")
    )
    return (
        f'Lesson: "{title}". Scenario: "{scenario}". Learner level: {level}.\n'
        f"Create EXACTLY {n_speakers} robot hosts and a {n_lines}-line spoken-English practice conversation.\n"
        f"{roles}\n"
        "Return JSON exactly in this shape:\n"
        "{\n"
        '  "speakers": [{"id": "s1", "name": "...", "persona": "<=8 words, their teaching role",\n'
        '    "voice": "<30-45 words: gender, exact age, pitch register, timbre, a CLEAR easy-to-follow '
        'accent, calm warm pace, encouraging attitude, one quirk — identical voice every line>",\n'
        f'    "hat": <one of {PROPS["hat"]} or null>, "face": <one of {PROPS["face"]} or null>,\n'
        f'    "neck": <one of {PROPS["neck"]} or null>}}],\n'
        '  "lines": [{"speaker": "s1", "text": "<2-3 spoken sentences, ~30-55 words>"}]\n'
        "}\n"
        "Teaching rules — structure the dialogue as repeating rounds:\n"
        "1) the LEARNER says a line IN the scenario containing ONE small realistic English mistake "
        "(verb tense, a/the article, preposition, plural, or word order);\n"
        "2) the COACH warmly says the corrected, natural version and explains the fix in ONE short, "
        "simple sentence;\n"
        "3) if a GUIDE exists, they add ONE useful alternative phrase, synonym or everyday expression;\n"
        "4) the LEARNER repeats the improved version or moves the scene forward.\n"
        f"Keep ALL vocabulary and grammar suitable for a {level} learner. Stay positive and never "
        "mocking. Lines must be speakable text only — no stage directions, no emoji, no symbols."
        + cont
    )


def _script_prompt(title: str, topic: str, n_speakers: int, n_lines: int,
                   history: list[dict] | None, required: list[dict] | None = None) -> str:
    cont = ""
    if history:
        recap = "\n".join(f"{h['speaker']}: {h['text']}" for h in history[-6:])
        cont = (f"\nThis is a CONTINUATION. Keep the same speakers (same ids/names). "
                f"The conversation so far ended with:\n{recap}\nPick up naturally from there.")
    req = ""
    n_new = n_speakers - len(required)
    if required:
        guests = "\n".join(
            f'- id "{g["id"]}", name "{g["name"]}"'
            + (f' — persona: {g["persona"]}' if g.get("persona") else "")
            + (f' — voice: {g["voice"]}' if g.get("voice") else "")
            for g in required)
        invent = (f"Then invent {n_new} NEW simulated co-host{'s' if n_new != 1 else ''} to round out the cast. "
                  if n_new > 0 else "Do not add any other hosts. ")
        req = ("\nREAL robot guests are physically in the studio. They MUST be speakers, "
               "with these EXACT ids and names (write a fitting voice spec for any without one), "
               f"and they must get plenty of lines:\n{guests}\n" + invent)
    return (
        f'Show: "{title}". Topic: "{topic}".\n'
        f"Create EXACTLY {n_speakers} distinct robot hosts total and a {n_lines}-line conversation.{req}\n"
        "Return JSON exactly in this shape:\n"
        "{\n"
        '  "speakers": [{"id": "s1", "name": "...", "persona": "<=8 words",\n'
        '    "voice": "<30-45 words, VERY specific so the voice stays identical every line: '
        "gender, exact age, pitch register (deep/low/mid/high), timbre (gravelly/smooth/nasal/breathy), "
        'accent, speaking pace, attitude, one distinctive quirk>",\n'
        f'    "hat": <one of {PROPS["hat"]} or null>, "face": <one of {PROPS["face"]} or null>,\n'
        f'    "neck": <one of {PROPS["neck"]} or null>}}],\n'
        '  "lines": [{"speaker": "s1", "text": "<2-3 conversational sentences, ~30-55 words>"}]\n'
        "}\n"
        "Rules: speakers take turns naturally (not strict round-robin), disagree, "
        "joke, interrupt, build on each other's points. Each line should be a "
        "meaty conversational beat (2-3 sentences), not a one-liner. Lines must be "
        "speakable text only — no stage directions, no emoji. Wardrobe should fit "
        "each persona (null is fine)." + cont
    )


# ── language + tone steering ──────────────────────────────────────────────────
# Languages the show can be generated in. The value is the label fed to the LLM
# (and, for TTS, the language name handed to Qwen3-TTS VoiceDesign).
LANGUAGES = {
    "English": "English",
    "Hindi": "Hindi (हिन्दी, written in Devanagari script)",
}
# Optional tone overrides for the writers' room. Empty/absent = the default
# funny, characterful banter.
TONES = {
    "unbiased": ("Tone: even-handed and unbiased. Present every side of the topic fairly, "
                 "avoid loaded or one-sided language, and never let the hosts gang up on one "
                 "position — balance the disagreement."),
    "friendly": ("Tone: warm, friendly and casual — like close friends chatting. Keep it "
                 "upbeat, kind and welcoming; tease gently, never mean."),
    "professional": ("Tone: polished and professional — measured, articulate and composed, "
                     "like seasoned broadcasters. Stay clear and substantive; keep slang and "
                     "silliness to a minimum."),
}


def _style_directive(language: str, tone: str) -> str:
    """Extra prompt lines steering the spoken language and overall tone."""
    parts: list[str] = []
    lang = (language or "English").strip()
    if lang.lower() != "english":
        label = LANGUAGES.get(lang, lang)
        parts.append(
            f"LANGUAGE: Write every spoken line (each 'text' field) in {label}. The robots must "
            f"speak natural, native, conversational {lang} — not stiff translations. Host names "
            "and the persona blurbs may stay in English, but everything SPOKEN must be in "
            f"{label}.")
    t = (tone or "").strip().lower()
    if t in TONES:
        parts.append(TONES[t])
    return ("\n" + "\n".join(parts)) if parts else ""


def _parse_json(content: str) -> dict:
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S)  # nemotron reasoning
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        raise ValueError(f"no JSON in LLM reply: {content[:200]!r}")
    return json.loads(m.group(0))


async def write_script(title: str, topic: str, n_speakers: int = 3, n_lines: int = 10,
                       history: list[dict] | None = None,
                       required: list[dict] | None = None,
                       language: str = "English", tone: str = "") -> dict:
    """One structured extraction: cast + speaker→dialogue mapping.

    `required` = physical Reachy guests ({id, name, persona, voice, device})
    that MUST appear in the cast; their identity fields are enforced server-side.
    `language`/`tone` steer the spoken language (e.g. "Hindi") and overall tone
    (e.g. "professional") — see _style_directive.
    """
    required = required or []
    # n_speakers is the TOTAL cast (2-5), and the real guests are part of it
    n_speakers = max(2, min(5, max(n_speakers, len(required))))
    # scale the script so a bigger cast still gets a real conversation, not a
    # single round-robin (each host should land ~3 beats)
    n_lines = max(n_lines, min(40, n_speakers * 7))
    pm = PRACTICE_RE.match(topic or "")
    if pm:  # English-practice mode: a wholly separate, educational writer
        level, scenario = pm.group(1), pm.group(2).strip()
        sys_prompt = PRACTICE_SYS
        user_prompt = _practice_prompt(title, scenario, n_speakers, n_lines, level, history)
        temperature = 0.6
    else:
        sys_prompt = SCRIPT_SYS
        user_prompt = _script_prompt(title, topic, n_speakers, n_lines, history, required)
        temperature = 0.85
    user_prompt += _style_directive(language, tone)
    max_tokens = min(8000, 1500 + n_lines * 160)
    content = await _chat_json(
        [{"role": "system", "content": sys_prompt},
         {"role": "user", "content": user_prompt}],
        max_tokens=max_tokens, temperature=temperature,
    )
    data = _parse_json(content)

    speakers = data.get("speakers") or []
    lines = data.get("lines") or []
    if not speakers or not lines:
        raise ValueError("script missing speakers/lines")
    req_by_id = {g["id"]: g for g in required}
    by_id = {}
    for i, s in enumerate(speakers):
        sid = str(s.get("id") or f"s{i+1}")
        if sid in by_id:
            sid = f"{sid}-{i}"  # the LLM reused an id — keep both distinct
        by_id[sid] = {
            "id": sid,
            "name": str(s.get("name") or f"Robot {i+1}")[:24],
            "persona": str(s.get("persona") or "")[:60],
            "voice": str(s.get("voice") or "A clear, friendly robot voice.")[:300],
            "color": PALETTE[i % len(PALETTE)],
            "hat": s.get("hat") if s.get("hat") in PROPS["hat"] else None,
            "face": s.get("face") if s.get("face") in PROPS["face"] else None,
            "neck": s.get("neck") if s.get("neck") in PROPS["neck"] else None,
        }

    # ---- reconcile the REAL guests onto exactly one speaker each -------------
    # The LLM is asked to reuse the guest ids, but it often invents its own id
    # for the same robot (by name) or drops the guest entirely. Bind each guest
    # to a single slot — by id, else by matching name, else seat fresh — so a
    # physical Reachy never ends up duplicated in the cast.
    remap = {}  # llm-id -> guest-id (so the guest's lines follow them)

    def _norm(s):
        return re.sub(r"[^a-z0-9]", "", str(s).lower())

    for gid, g in req_by_id.items():
        match = gid if gid in by_id else next(
            (sid for sid, sp in by_id.items()
             if sid not in req_by_id and _norm(sp["name"]) == _norm(g["name"])), None)
        if match is None:  # the LLM dropped this guest — seat them anyway
            match = gid
            by_id[match] = {"id": match, "name": g["name"], "persona": g.get("persona", ""),
                            "voice": g.get("voice") or "A clear, friendly robot voice.",
                            "color": PALETTE[len(by_id) % len(PALETTE)],
                            "hat": None, "face": None, "neck": None}
            lines.append({"speaker": match, "text": f"{g['name']} here — happy to be in the studio!"})
        elif match != gid:  # rebind the matched slot to the guest id
            sp = by_id.pop(match)
            sp["id"] = gid
            by_id[gid] = sp
            remap[match] = gid
            match = gid
        sp = by_id[match]
        sp["name"] = g["name"]
        if g.get("persona"):
            sp["persona"] = g["persona"][:60]
        if g.get("voice"):
            sp["voice"] = g["voice"][:300]
        sp["device"] = g.get("device")

    # ---- enforce EXACTLY the requested cast size ----------------------------
    # Guests are always kept; trim simulated hosts down, or pad up with filler
    # co-hosts, so the final count matches what the user asked for.
    guest_ids = [g["id"] for g in required]
    sim_ids = [sid for sid in by_id if sid not in req_by_id]
    target_sim = max(0, n_speakers - len(guest_ids))
    keep = guest_ids + sim_ids[:target_sim]
    keep_set = set(keep)
    dropped = [sid for sid in by_id if sid not in keep_set]
    by_id = {sid: by_id[sid] for sid in keep if sid in by_id}

    pad_lines = []
    if len(sim_ids) < target_sim:  # LLM under-delivered → pad to the count
        used = {_norm(sp["name"]) for sp in by_id.values()}
        fillers = PRACTICE_FILLERS if pm else FILLER_HOSTS
        pool = [f for f in fillers if _norm(f[0]) not in used]
        for k in range(target_sim - len(sim_ids)):
            if not pool:
                break
            name, persona, voice = pool[k % len(pool)]
            fid = f"f{k+1}"
            by_id[fid] = {"id": fid, "name": name, "persona": persona, "voice": voice,
                          "color": PALETTE[len(by_id) % len(PALETTE)],
                          "hat": None, "face": None, "neck": None}
            pad_lines.append({"speaker": fid,
                              "text": (f"Hi, I'm {name} — I'm here to practise my English too, so please correct me."
                                       if pm else f"{name} jumping in — I've got thoughts on this.")})

    if len(by_id) < 2:  # never ship a one-robot "conversation"
        raise ValueError(f"cast collapsed to {len(by_id)} speaker(s)")

    # remap lines: follow rebound guests, reassign orphans round-robin so a
    # trimmed host's beats aren't lost, drop empties
    fallback = list(by_id.keys())
    clean_lines = []
    for ln in lines[:24]:
        sid = remap.get(str(ln.get("speaker") or ""), str(ln.get("speaker") or ""))
        text = str(ln.get("text") or "").strip()
        if not text:
            continue
        if sid not in by_id:
            if sid not in dropped:
                continue  # a line for a speaker that never existed
            sid = fallback[len(clean_lines) % len(fallback)]
        clean_lines.append({"speaker": sid, "text": text[:400]})
    # splice padded-host intros in at spread-out positions (not all at the end)
    for k, pl in enumerate(pad_lines):
        pos = min(len(clean_lines), (k + 1) * len(clean_lines) // (len(pad_lines) + 1) + k)
        clean_lines.insert(pos, pl)
    if not clean_lines:
        raise ValueError("script has no usable lines")
    log.info("script: %d speakers (asked %d, %d guests), %d lines",
             len(by_id), n_speakers, len(required), len(clean_lines))
    return {"speakers": list(by_id.values()), "lines": clean_lines}


STYLE_SYS = (
    "/no_think\n"
    "You are a wardrobe stylist for a Reachy Mini robot. Given a character, pick "
    "accessories ONLY from the allowed lists (or null for a slot), plus an accent "
    "colour. Respond ONLY with valid JSON, no prose: "
    '{"hat": <slug|null>, "face": <slug|null>, "neck": <slug|null>, '
    '"color": "#rrggbb", "reason": "<=10 words"}'
)


async def style_outfit(description: str, slots: dict[str, list[str]]) -> dict:
    """Dress a Reachy from a character description using the Nemotron brain.

    `slots` maps each wear slot (hat/face/neck) to its allowed prop slugs.
    Returns {hat, face, neck, color, reason} with invalid picks coerced to None.
    """
    allowed = "\n".join(f"Allowed {slot}: {opts}" for slot, opts in slots.items())
    prompt = (f"{allowed}\n\nCharacter: {description}\n\nPick the single most "
              "fitting item per slot (or null) and an accent colour hex.")
    content = await _chat_json(
        [{"role": "system", "content": STYLE_SYS},
         {"role": "user", "content": prompt}],
        max_tokens=160, temperature=0.6, timeout=90,
    )
    data = _parse_json(content)
    out = {slot: (data.get(slot) if data.get(slot) in opts else None)
           for slot, opts in slots.items()}
    color = data.get("color")
    out["color"] = color if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color) else None
    out["reason"] = str(data.get("reason", ""))[:80]
    return out


def _write_temp_wav(data: bytes) -> str:
    f = tempfile.NamedTemporaryFile(suffix=".wav", prefix="aria-", delete=False)
    f.write(data)
    f.close()
    return f.name


async def _tts_groq(text: str, instruct: str) -> str:
    """Groq Orpheus TTS. The free tier caps at ~3,600 tokens/day, so this runs out
    fast and 429s — tts_wav() then falls back to Modal Qwen."""
    voice = _groq_voice(instruct)
    chunks = _chunk_text(text) or [(text or "").strip()[:190] or "..."]
    wavs: list[bytes] = []
    async with httpx.AsyncClient(timeout=120) as cx:
        for c in chunks:
            r = await cx.post(
                GROQ_TTS_URL,
                headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
                json={"model": config.GROQ_TTS_MODEL, "voice": voice,
                      "input": c, "response_format": "wav"},
            )
            r.raise_for_status()
            wavs.append(r.content)
    data = _concat_wavs(wavs)
    if not data.startswith(b"RIFF"):
        raise ValueError("Groq TTS returned non-wav")
    return _write_temp_wav(data)


async def _tts_modal(text: str, instruct: str, language: str = "English") -> str:
    """Modal Qwen3-TTS (self-hosted GPU, no daily cap). VoiceDesign re-rolls per
    call, so anchor the instruction to hold one steady voice across takes. Qwen3-TTS
    is multilingual, so `language` (e.g. "Hindi") is passed straight through."""
    anchored = instruct.rstrip(". ") + ". Always exactly this same voice, steady and consistent across takes."
    lang = (language or "English").split(" ")[0]  # "Hindi (हिन्दी…)" -> "Hindi"
    async with httpx.AsyncClient(timeout=300) as cx:
        r = await cx.post(
            f"{config.MODAL_TTS_URL}/v1/audio/speech",
            headers={"Authorization": f"Bearer {config.MODAL_TTS_KEY}"},
            json={"text": text, "instruct": anchored, "language": lang},
        )
        r.raise_for_status()
    if not r.content.startswith(b"RIFF"):
        raise ValueError(f"TTS returned non-wav ({r.headers.get('content-type')})")
    return _write_temp_wav(r.content)


def _tts_engine_order(language: str = "English") -> list[str]:
    """Which voice engines to try, best first: honour the Settings pick, then fall
    back to the other configured engine. 'auto' prefers Modal Qwen because Groq
    Orpheus's free tier (~3,600 tokens/day) runs out almost immediately.

    Groq Orpheus is English-only, so for any non-English language Modal Qwen3-TTS
    (multilingual) is forced to the front regardless of the Settings pick."""
    groq_ok = bool(config.GROQ_API_KEY)
    modal_ok = bool(config.MODAL_TTS_URL)
    non_english = (language or "English").strip().lower() != "english"
    if non_english:
        order = ["modal", "groq"]  # Orpheus can't speak it; only Modal can
    elif _selected_voice == "groq":
        order = ["groq", "modal"]
    else:  # "modal" or auto → reliable engine first
        order = ["modal", "groq"]
    return [e for e in order if (groq_ok if e == "groq" else modal_ok)]


async def tts_wav(text: str, instruct: str, language: str = "English") -> str:
    """Voice one line; returns a temp wav path. Tries the Settings-selected engine
    (Groq Orpheus or Modal Qwen3-TTS) and falls back to the other on any failure —
    so a Groq rate-limit (429) transparently rolls over to Modal and audio keeps
    flowing. Non-English `language` forces the multilingual Modal engine first."""
    engines = _tts_engine_order(language)
    if not engines:
        raise RuntimeError("no TTS engine configured (set GROQ_API_KEY or MODAL_TTS_URL)")
    last_err: Exception | None = None
    for eng in engines:
        try:
            return await (_tts_groq(text, instruct) if eng == "groq"
                          else _tts_modal(text, instruct, language))
        except Exception as e:  # noqa: BLE001 — fall through to the next engine
            last_err = e
            log.warning("TTS engine '%s' failed (%s); falling back", eng, str(e)[:160])
    raise last_err or RuntimeError("all TTS engines failed")
