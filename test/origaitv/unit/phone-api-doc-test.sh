#!/bin/bash

# Guards docs/phone-api.md against the code it's written from, where a
# number or a name can be read out of both: the remote's key names against
# daemon/input.py, how long each route can wait against the daemon's own
# limits, and the phone page's remote against companion-web/remote2.ts.
#
# When one of these fails, the code changed and the doc didn't, or the other
# way round. Change the one that's wrong. If the code's line was only
# rewritten, change the pattern here that reads it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

python3 -I - "$ROOT" <<'PY'
import re
import sys

root = sys.argv[1]
sys.path.insert(0, f"{root}/daemon")
import input as origaitv_input

with open(f"{root}/docs/phone-api.md", encoding="utf-8") as file:
    doc = file.read()


def section(title):
    """What's under a heading, up to the next heading of any depth."""
    found = re.search(rf"^#{{2,4}} {re.escape(title)}\n(.*?)(?=^#{{2,4}} |\Z)", doc, re.S | re.M)
    assert found, f"docs/phone-api.md has no section called {title!r}"
    return found.group(1)


def codes(path, pattern):
    """The numbers in the code, by the line that sets them."""
    with open(f"{root}/{path}", encoding="utf-8") as file:
        found = re.search(pattern, file.read(), re.S)
    assert found, f"{path} has no line like {pattern!r} any more: read it again, then this test and the doc"
    return tuple(float(group.replace("_", "")) for group in found.groups())


def code(path, pattern):
    return codes(path, pattern)[0]


def row(text, start):
    for line in text.splitlines():
        if line.startswith(f"| {start}"):
            return line
    raise AssertionError(f"the doc's table has no row starting {start!r}")


def bullet(text, start):
    for line in text.splitlines():
        if line.startswith(f"- {start}"):
            return line
    raise AssertionError(f"the doc has no line starting {start!r}")


def seconds(line):
    return [int(n) for n in re.findall(r"(\d+) seconds", line)]


def same(what, said, expected):
    assert said == expected, f"{what}: the doc says {said}, and the code says {expected}"


# --- The key names -----------------------------------------------------------

named = set()
for first in re.findall(r"^\| (.+?) \|", section("The key names"), re.M):
    span = re.fullmatch(r"`(\w)` to `(\w)`", first)
    if span:
        named |= {chr(c) for c in range(ord(span.group(1)), ord(span.group(2)) + 1)}
    else:
        named |= set(re.findall(r"`([a-z0-9-]+)`", first))
keys = set(origaitv_input.KEYS)
assert not keys - named, f"daemon/input.py takes keys the doc doesn't name: {sorted(keys - named)}"
assert not named - keys, f"the doc names keys daemon/input.py doesn't take: {sorted(named - keys)}"
# The route lets through every name input.py has, and nothing shaped otherwise.
assert all(re.fullmatch(r"[a-z0-9-]{1,12}", key) for key in keys), "a key's name is 1 to 12 of a-z, 0-9 and -"
print(f"ok - T28.2 the doc names every key daemon/input.py takes, all {len(keys)}, and no other")

# --- How long a route can wait ----------------------------------------------

timeouts = section("Timeouts")
wait = code("daemon/server.ts", r"const PHONE_WAIT_MS = ([\d_]+);") / 1000
same("the long poll", seconds(row(timeouts, "`GET /api/phone/state`")), [wait])
assert f"or {wait:g} seconds go by" in section("The long poll"), "the long poll's own section says the same"

answer = code("daemon/routes/remote.ts", r"const ANSWER_MS = ([\d_]+);") / 1000
same("text", seconds(row(timeouts, "`POST /api/phone/text`")), [answer, 2 * answer])
playback = code("daemon/routes/remote.ts", r"const PLAYBACK_MS = ([\d_]+);") / 1000
full = code("daemon/routes/remote.ts", r"const PLAYBACK_FULL_MS = ([\d_]+);") / 1000
same("playback", seconds(row(timeouts, "`POST /api/phone/playback`")), [playback, full])

same("key", seconds(row(timeouts, "`POST /api/phone/key`")), [code("daemon/key.ts", r"options\.waitMs \?\? ([\d_]+)") / 1000])
same("location", seconds(row(timeouts, "`PUT /api/phone/location`")), [code("daemon/country.ts", r"this\.o\.waitMs \?\? ([\d_]+)") / 1000])
smb = code("daemon/discover.ts", r"const SMB_MS = ([\d_]+);") / 1000
ask = code("daemon/discover.ts", r"const ASK_MS = ([\d_]+);") / 1000
same("a NAS's folders", seconds(row(timeouts, "`GET` and `POST /api/phone/discover/shares`")), [smb + 2 * ask, smb, ask])
same("an AI's icon", seconds(row(timeouts, "`GET /api/phone/ai/icon/<provider>`")), [code("daemon/site-icon.ts", r"const TIMEOUT_MS = ([\d_]+);") / 1000])
same("the box", seconds(row(timeouts, "`GET /api/phone/box`")), [code("daemon/box.ts", r"execFile\(command, args, \{ timeout: ([\d_]+),") / 1000])
push = code("daemon/server.ts", r'kind: "push".{0,200}?\}, ([\d_]+) \* 60_000\)')
assert f"| {push:g} minutes |" in row(timeouts, "`POST /api/phone/apps/<app id>/push`"), f"the push has {push:g} minutes"

router = code("daemon/router-client.ts", r"export function viaSocket\([^\n]*timeoutMs = ([\d_]+)\)") / 1000
search = code("daemon/say.ts", r"const SEARCH_MS = ([\d_]+);") / 1000
opening = code("daemon/say.ts", r"const OPEN_MS = ([\d_]+);") / 1000
show = code("daemon/say.ts", r"const SHOW_MS = ([\d_]+);") / 1000
same("a sentence", seconds(bullet(timeouts, "**`say` answers")), [router, search, opening, opening, show])
same("a pick", seconds(bullet(timeouts, "**`say/pick` opens")), [opening, show])
same("a pick's row", seconds(row(timeouts, "`POST /api/phone/say/pick`")), [opening])
print("ok - T28.2 every wait in the doc's Timeouts is the one the code has")

grant = code("daemon/pin.ts", r"export const GRANT_MS = ([\d_]+) \* 60_000;")
assert f"A grant lasts {grant:g} minutes" in section("The PIN grant"), f"a grant lasts {grant:g} minutes"
print("ok - a PIN grant lasts as long as the doc says")

# --- The remote ---------------------------------------------------------------

routes = section("The remote")
low, high, usual = codes("daemon/server.ts", r"Math\.max\((\d+), Math\.min\((\d+), Number\(body\.ms\) \|\| (\d+)\)\)")
assert f"kept between {low:g} and {high:g}, and is {usual:g} when left out" in routes, f"a hold is kept between {low:g} and {high:g} ms, and is {usual:g}"

most = code("daemon/routes/remote.ts", r"export const TEXT_MAX = (\d+);")
assert f"`value` can be up to {most:g} characters, counted as Unicode code points" in section("Typing into a field"), f"typed text is up to {most:g} characters"

page = section("What the phone's page sends")
remote2 = "companion-web/remote2.ts"
hold = code(remote2, r"const HOLD_MS = (\d+);")
back = code(remote2, r"const BACK_HOLD_MS = (\d+);")
sent = code(remote2, r'this\.send\(\{ hold: "back", ms: (\d+) \}\)')
step = code(remote2, r"const STEP_PX = (\d+);")
still = code(remote2, r"const STILL_PX = (\d+);")
first = code(remote2, r"const EDGE_REPEAT_MS = (\d+);")
every = code(remote2, r"const EDGE_EVERY_MS = (\d+);")
inner = code(remote2, r"const EDGE_INNER = ([\d.]+);")
scroll = code(remote2, r"const SCROLL_EVERY_MS = (\d+);")
for phrase in (
    f"down for under {hold:g} ms and didn't swipe",
    f"has been down for {hold:g} ms",
    f"for every {step:g} px the finger goes",
    f"the arrow goes after {first:g} ms and then every {every:g} ms",
    f"At most every {scroll:g} ms, with what's gathered",
    f"down for under {back:g} ms",
    f'`{{"hold":"back","ms":{sent:g}}}` | Once it has been down for {back:g} ms',
    f"within {still:g} px of where it went down",
    f"more than {inner:g} of the radius",
):
    assert phrase in page, f"the doc's remote no longer says {phrase!r}, which is what {remote2} does"

# The TV's own two holds, and that the hold the page sends outlasts Back's.
tv_back = code("daemon/screen.ts", r"options\.backHoldMs \?\? (\d+);")
tv_ok = code("launcher/input.ts", r"export const HOLD_MS = (\d+);")
holds = section("Holds")
assert tv_back == 1000 and "The TV counts a second from when Esc goes down" in holds, "Back's hold is a second on the TV"
assert sent > tv_back and f'`{{"hold":"back","ms":{sent:g}}}`' in holds, "the hold the page sends is longer than the TV's count"
assert f"A held `enter` of {tv_ok:g} ms or more" in holds and f"Held for {tv_ok:g} ms on an app's tile" in section("The key names"), f"OK's hold is {tv_ok:g} ms on the TV"
print("ok - the remote's holds and timings in the doc are the page's and the TV's own")
PY
