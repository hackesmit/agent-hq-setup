"""Subjects of the mail our own automation sends as the owner.

The voice build drops this mail and mail-watch labels it noise. The generic
subjects live here; the client's report subjects are private, one regex
alternative per line in ops/reference/automated-subjects.txt (never
exported; VOICE_SUBJECTS overrides the path). A missing file leaves only
the generic subjects, so that mail goes to the model instead of a rule.
"""

import os
import re
from pathlib import Path

from .paths import HQ

GENERIC = [r"Your news daily summary", r"\[HQ\]", r"HQ "]
FILE = Path(os.environ.get("VOICE_SUBJECTS", str(HQ / "ops" / "reference" / "automated-subjects.txt")))


def private(path=None):
    """The regex alternatives in the private file; [] when it is missing."""
    try:
        text = Path(path or FILE).read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def pattern(path=None):
    """One case-insensitive regex: an optional PRUEBA: prefix, then any known subject."""
    alts = GENERIC + private(path)
    return re.compile(r"^(PRUEBA:?\s*)?(%s)" % "|".join("(?:%s)" % a for a in alts), re.I)
