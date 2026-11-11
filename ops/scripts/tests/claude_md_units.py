"""Split a CLAUDE.md into rule units: one per sentence of prose, bullet or list
item, and one per table row. Headings, fences, table separators and blank lines
are not units. Used by claude-md-shrink.test.sh to prove no rule was lost."""
import re


def units(text):
    out = []
    for line in text.splitlines():
        t = line.strip()
        if not t or t.startswith("#") or t.startswith("```") or t.startswith("<!--"):
            continue
        if re.fullmatch(r"\|[-| :]+\|", t):
            continue
        if t.startswith("|"):
            out.append(t)
            continue
        t = re.sub(r"^(?:[-*]|\d+\.)\s+", "", t)
        # Sentence split: end punctuation, then space, then a capital, a code
        # span, bold or a bracket. Dots inside code spans are protected.
        spans = []
        prot = re.sub(r"`[^`]*`", lambda m: spans.append(m.group(0)) or "\0%d\0" % (len(spans) - 1), t)
        parts = re.split(r"(?<=[.!?])\s+(?=[A-Z\0*(\[\"])", prot)
        for p in parts:
            p = re.sub(r"\0(\d+)\0", lambda m: spans[int(m.group(1))], p).strip()
            if p:
                out.append(p)
    return out


if __name__ == "__main__":
    import sys
    for i, u in enumerate(units(open(sys.argv[1]).read())):
        print("%d\t%s" % (i, u))
