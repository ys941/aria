"""Attribution enforcement.

Clause 2 of the LICENCE requires that any deployment other people can see
displays visible credit to the original author. Two checks run once, when the
server starts:

  1. ACKNOWLEDGEMENT -- ATTRIBUTION_ACK must be set to the author's profile.
  2. VISIBLE CREDIT  -- the UI footer must still contain that credit.

The second check fails only on *positive evidence* that the credit was removed.
If it cannot inspect anything (an unusual deployment layout, a read-only or
partial filesystem) it warns and lets the app start, so a legitimate deployment
is never broken by a check that simply could not see the file.

Removing these checks does not remove the obligation -- see LICENSE clause 2.
"""

from __future__ import annotations

import os
import pathlib
import sys

AUTHOR_NAME = "Yati Bhardwaj"
AUTHOR_HANDLE = "ys941"
AUTHOR_URL = "https://github.com/ys941"

_ROOT = pathlib.Path(__file__).resolve().parent.parent

# Accepted forms of the acknowledgement, normalised.
_ACCEPTED = {
    "https://github.com/ys941",
    "http://github.com/ys941",
    "github.com/ys941",
    "@ys941",
    "ys941",
}

# Files expected to carry the visible credit, in priority order.
_CREDIT_FILES = (
    pathlib.Path("frontend") / "index.html",
    pathlib.Path("frontend") / "dist" / "index.html",
)


def _normalise(value: str) -> str:
    return value.strip().rstrip("/").lower()


def has_attribution_ack() -> bool:
    """True when the operator has acknowledged the attribution requirement."""
    raw = os.environ.get("ATTRIBUTION_ACK")
    return isinstance(raw, str) and _normalise(raw) in _ACCEPTED


def check_visible_credit(root: pathlib.Path | None = None) -> tuple[str, str]:
    """Verify the UI still credits the author.

    Returns (status, detail) where status is "ok", "missing" or "unverifiable".
    """
    base = root or _ROOT
    for rel in _CREDIT_FILES:
        path = base / rel
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return "unverifiable", f"{rel.as_posix()} could not be read"
        if AUTHOR_URL in text or f"github.com/{AUTHOR_HANDLE}" in text:
            return "ok", rel.as_posix()
        return "missing", rel.as_posix()

    return "unverifiable", "no UI file found to inspect"


_ACK_FAILURE = f"""
────────────────────────────────────────────────────────────────────────
  Aria will not start without attribution.

  It is free to use, fork, rebrand and sell — the one condition is that
  credit to the original author stays visible. That is clause 2 of the
  LICENCE, not a preference.

  Add this to your .env (or your host's environment):

      ATTRIBUTION_ACK="{AUTHOR_URL}"

  Nothing is transmitted. No network call is made, no telemetry is
  collected, no licence server is contacted — the value is compared to a
  string in this file and that is all.

  Built by {AUTHOR_NAME} · {AUTHOR_URL}
────────────────────────────────────────────────────────────────────────
"""


def _credit_failure(where: str) -> str:
    return f"""
────────────────────────────────────────────────────────────────────────
  The author credit has been removed from {where}.

  Clause 2 of the LICENCE requires any deployment other people can see to
  display visible credit to the original author:

      Made with love by {AUTHOR_NAME} — {AUTHOR_URL}

  Restore the credit in the UI footer and the app will start.

  Everything around it is still yours: rename the show, change the themes,
  the robots, the voices. Just leave the one line that says who built it.
────────────────────────────────────────────────────────────────────────
"""


def assert_attribution() -> None:
    """Run both attribution checks. Raises RuntimeError if credit is absent."""
    if not has_attribution_ack():
        print(_ACK_FAILURE, file=sys.stderr)
        raise RuntimeError(
            f'Attribution required: set ATTRIBUTION_ACK="{AUTHOR_URL}" to start Aria. '
            "See LICENSE clause 2."
        )

    status, detail = check_visible_credit()

    if status == "missing":
        print(_credit_failure(detail), file=sys.stderr)
        raise RuntimeError(
            f"Attribution required: the author credit is missing from {detail}. "
            "See LICENSE clause 2."
        )

    if status == "unverifiable":
        print(
            f"[attribution] Could not verify the visible credit ({detail}). "
            "Clause 2 of the LICENCE still requires it to be displayed.",
            file=sys.stderr,
        )
