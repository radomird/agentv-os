#!/bin/bash

# Guards game mode's TV side (ADR-113, T26.1): the controller a phone is.
# - daemon/input.py: what the device is made with, what's written to it for
#   each state, the guide button's hold, and the connection to the daemon
#   that every controller lives and dies with. The uinput device itself
#   needs the box, where the image check has a game read it (T26.2). Here
#   the calls that make it are written down, and the events go to a
#   stand-in.
# - daemon/pads.ts, pad-wire.ts, routes/pad.ts and the channel's part: a
#   stand-in phone against a real daemon, with the input helper's own code
#   on the other side (phonepad.test.mts).
# - docs/phone-api.md's vectors for game mode, replayed
#   (phonepad-vectors.test.mts).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

run() {
  python3 -I - "$ROOT/daemon" <<'PY'
import json, os, socket, struct, sys, tempfile, threading, time
sys.path.insert(0, sys.argv[1])
import input as origaitv_input

EV_KEY, EV_ABS = 1, 3

# --- What the device is made with -------------------------------------------
# The calls create_pad makes, written down in place of a real /dev/uinput.
calls = []
closed = []
real = (origaitv_input.os.open, origaitv_input.os.close, origaitv_input.fcntl.ioctl)
origaitv_input.os.open = lambda path, flags: calls.append(("open", path)) or 7
origaitv_input.os.close = closed.append
origaitv_input.fcntl.ioctl = lambda fd, request, arg=0: calls.append((request, arg))
try:
    assert origaitv_input.create_pad() == 7
    made = list(calls)
    # A box that won't make it: the file is closed, and the error is the caller's.
    def refuse(fd, request, arg=0):
        raise OSError(13, "Permission denied")
    origaitv_input.fcntl.ioctl = refuse
    try:
        origaitv_input.create_pad()
        raise AssertionError("made a device the box refused")
    except OSError:
        pass
    assert closed == [7], closed
finally:
    origaitv_input.os.open, origaitv_input.os.close, origaitv_input.fcntl.ioctl = real

assert made[0] == ("open", "/dev/uinput")
by = lambda request: [arg for call, arg in made[1:] if call == request]
assert by(origaitv_input.UI_SET_EVBIT) == [EV_KEY, EV_ABS], "buttons and axes, and nothing a keyboard or a mouse has"
# A, B, X, Y, the two front shoulders, View, Menu, the guide button and the
# two stick clicks: the wired controller's buttons, in its order.
assert by(origaitv_input.UI_SET_KEYBIT) == [0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x13A, 0x13B, 0x13C, 0x13D, 0x13E], by(origaitv_input.UI_SET_KEYBIT)
assert by(origaitv_input.UI_SET_ABSBIT) == [0, 1, 2, 3, 4, 5, 16, 17], "two sticks, two triggers and the d-pad's hat"
axes = [struct.unpack("HHiiiiii", arg) for arg in by(origaitv_input.UI_ABS_SETUP)]
assert [(code, low, high) for code, _, _, low, high, _, _, _ in axes] == [
    (0, -32768, 32767), (1, -32768, 32767), (2, 0, 255), (3, -32768, 32767), (4, -32768, 32767), (5, 0, 255), (16, -1, 1), (17, -1, 1),
], axes
assert all(fuzz == 0 and flat == 0 for *_, fuzz, flat, _ in axes), "the stick is given as the phone sent it"
bus, vendor, product, version, name, effects = struct.unpack("HHHH80sI", by(origaitv_input.UI_DEV_SETUP)[0])
assert (bus, vendor, product, version) == (0x03, 0x045E, 0x028E, 0x0114), "the ids games know a wired controller by"
assert name.rstrip(b"\0") == b"OrigaiTV phone controller" and effects == 0
assert made[-1] == (origaitv_input.UI_DEV_CREATE, 0), "made last, once it's all set"
assert struct.calcsize("HHiiiiii") == 28 and origaitv_input.UI_ABS_SETUP == (1 << 30) | (28 << 16) | (0x55 << 8) | 4
assert origaitv_input.UI_SET_ABSBIT == (1 << 30) | (4 << 16) | (0x55 << 8) | 103
print("ok - T26.1 the controller is made with the wired controller's buttons, axes and ids, and its own name")

# --- What's written to it -----------------------------------------------------
written = []
def events():
    out = []
    for chunk in written:
        report = []
        for i in range(0, len(chunk), 24):
            _, _, kind, code, value = struct.unpack("llHHi", chunk[i:i + 24])
            report.append((kind, code, value))
        assert report[-1] == (0, 0, 0), "each state is one report"
        out.append(report[:-1])
    written.clear()
    return out

pad = origaitv_input.Pad(written.append)
pad.set(0b1, 0, 0)
pad.set(0b1, 0, 0)
pad.set(0b11000001, 20000, -32767)
pad.set(0, 0, 0)
assert events() == [
    [(1, 0x130, 1)],
    [(3, 2, 255), (3, 5, 255), (3, 0, 20000), (3, 16, 1), (3, 1, -32767), (3, 17, -1)],
    [(1, 0x130, 0), (3, 2, 0), (3, 5, 0), (3, 0, 0), (3, 16, 0), (3, 1, 0), (3, 17, 0)],
], "what changed, and nothing for a state that's the same"
assert [origaitv_input.dpad(v) for v in (-32767, -16384, -16383, 0, 16383, 16384, 32767)] == [-1, -1, 0, 0, 0, 1, 1]
for bad in ((2048, 0, 0), (-1, 0, 0), (0, 32768, 0), (0, 0, -32768), (True, 0, 0), (0, 1.5, 0), ("1", 0, 0), (0, None, 0)):
    try:
        pad.set(*bad)
    except ValueError:
        continue
    raise AssertionError(f"took {bad}")
assert events() == [] and (pad.buttons, pad.x, pad.y) == (0, 0, 0), "nothing half written"
print("ok - T26.1 a state is written as what changed, the stick as the d-pad too, and anything else is refused")

# --- The controllers the daemon asks for --------------------------------------
now = [100.0]
said = []
gone = []
fails = []
def make(slot):
    if fails:
        raise OSError(13, "Permission denied: '/dev/uinput'")
    return written.append, lambda: gone.append(slot)
pads = origaitv_input.PhonePads(make, lambda: said.append("guide"), lambda: said.append("guide-hold"), hold=1.0, clock=lambda: now[0])
assert pads.handle({"open": 1}) == [{"opened": 1}]
assert pads.handle({"open": 4}) == [{"opened": 4}]
for bad in ({"open": 0}, {"open": 5}, {"open": "1"}, {"open": True}, {"open": [1]}, {"state": [2, 0, 0, 0], "n": 1}, {"state": [[1], 0, 0, 0], "n": 1}, {"state": [1, 0, 0]}, {"state": "1"}, {"state": [1, 4096, 0, 0], "n": 1}, {"close": 3}, {"close": [1]}, {"close": "1"}, {"beat": 1}, {}, [1], "open", 7):
    assert pads.handle(bad) == [], bad
assert sorted(pads.pads) == [1, 4] and events() == [] and gone == []
assert pads.handle({"state": [1, 1, 0, 0], "n": 7}) == [{"took": [1, 7]}]
assert pads.handle({"state": [4, 2, 0, 0], "n": 3}) == [{"took": [4, 3]}]
assert events() == [[(1, 0x130, 1)], [(1, 0x131, 1)]], "each phone moves its own"
# Asked for again, the old one goes first.
assert pads.handle({"open": 1}) == [{"opened": 1}] and gone == [1]
assert pads.pads[1][0].buttons == 0, "a new controller holds nothing"
pads.handle({"close": 4})
assert gone == [1, 4] and sorted(pads.pads) == [1]
# A box that won't make one says so, and has none.
fails.append(True)
assert pads.handle({"open": 2}) == [{"failed": 2, "why": "[Errno 13] Permission denied: '/dev/uinput'"}]
assert sorted(pads.pads) == [1]
fails.clear()
print("ok - T26.1 the daemon's lines make, move and take away controllers 1 to 4, and nothing else")

# The guide button, by a real controller's rule (ADR-084): the press is
# said as it goes down, and the hold once, a second on, while it's down.
HOME = 1 << 10
pads.handle({"open": 2})
gone.clear()
assert pads.wait() == 1.0, "nothing held: a second at most"
pads.handle({"state": [1, HOME, 0, 0], "n": 1})
assert said == ["guide"]
now[0] += 0.4
assert abs(pads.wait() - 0.6) < 1e-6
pads.tick()
pads.handle({"state": [1, 0, 0, 0], "n": 2})
now[0] += 2
pads.tick()
assert said == ["guide"], "a tap is a press and nothing more"
pads.handle({"state": [1, HOME | 1, 0, 0], "n": 3})
now[0] += 0.5
# The other phone taps its own meanwhile.
pads.handle({"state": [2, HOME, 0, 0], "n": 1})
pads.handle({"state": [2, 0, 0, 0], "n": 2})
# Other buttons, and the same state again, don't start it over.
pads.handle({"state": [1, HOME, 100, 0], "n": 4})
pads.handle({"state": [1, HOME, 100, 0], "n": 5})
now[0] += 0.49
pads.tick()
assert said == ["guide", "guide", "guide"]
now[0] += 0.02
assert pads.wait() == 0.0
pads.tick()
pads.tick()
now[0] += 5
pads.tick()
pads.handle({"state": [1, 0, 0, 0], "n": 6})
assert said == ["guide", "guide", "guide", "guide-hold"], said
said.clear()
# A controller that goes away with the button down takes its hold with it.
pads.handle({"state": [2, HOME, 0, 0], "n": 3})
pads.handle({"close": 2})
now[0] += 3
pads.tick()
assert said == ["guide"] and gone == [2]
pads.close_all()
assert gone == [2, 1] and pads.pads == {} and pads.down == {}
print("ok - T26.1 a phone's guide button held goes home by a real controller's rule, each phone's hold its own")

# A phone's controller isn't read back as a gamepad: its guide button is
# timed as it's written.
root = tempfile.mkdtemp()
for name, number, called in (("event3", "13:67", "Some wired controller"), ("event5", "13:69", "OrigaiTV phone controller")):
    os.makedirs(os.path.join(root, "sys/class/input", name, "device"))
    with open(os.path.join(root, "sys/class/input", name, "dev"), "w") as file:
        file.write(number + "\n")
    with open(os.path.join(root, "sys/class/input", name, "device/name"), "w") as file:
        file.write(called + "\n")
    os.makedirs(os.path.join(root, "run/udev/data"), exist_ok=True)
    with open(os.path.join(root, "run/udev/data", f"c{number}"), "w") as file:
        file.write("E:ID_INPUT=1\nE:ID_INPUT_JOYSTICK=1\n")
found = [os.path.basename(path) for path in origaitv_input.gamepads(root)]
assert found == ["event3"], found
print("ok - the guide button's watcher leaves the phones' controllers alone, so a press is said once")

# --- The connection to the daemon ---------------------------------------------
# A stand-in daemon: what it answers a helper that connects, and what it
# heard on each connection.
server = socket.socket()
server.bind(("127.0.0.1", 0))
server.listen(8)
address = server.getsockname()
plan = []
heard = []
asked = []
def listen(conn, into):
    while True:
        try:
            chunk = conn.recv(4096)
        except OSError:
            return
        if not chunk:
            return
        into.append(chunk.decode())
def daemon():
    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            return
        head = b""
        while b"\r\n\r\n" not in head:
            head += conn.recv(4096)
        asked.append((time.monotonic(), head.decode()))
        act = plan.pop(0) if plan else "refuse"
        if act == "refuse":
            body = b'{"ok":false,"error":"not found"}'
            conn.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
            conn.close()
            continue
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: origaitv-pads\r\nConnection: Upgrade\r\n\r\n")
        heard.append([])
        threading.Thread(target=listen, args=(conn, heard[-1]), daemon=True).start()
        for step in act:
            if isinstance(step, float):
                time.sleep(step)
            else:
                conn.sendall(step)
        # Hung up for good: closing alone leaves it open on Linux while the
        # thread above is still reading it.
        try:
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        conn.close()
threading.Thread(target=daemon, daemon=True).start()

gone.clear()
written.clear()
linked = origaitv_input.PhonePads(make, lambda: None, lambda: None)
logged = []
stop = threading.Event()
plan.extend([
    # Game mode's switch is off: the daemon says no, twice.
    "refuse", "refuse",
    # On: a controller is made and moved, a line that isn't one is passed
    # over, and the daemon goes away with the controller still there.
    [b'{"open":1}\n', 0.1, b'not json\n{"nope":1}\n{"state":[1,1,0,0],"n":5}\n', 0.1, b'{"open":2}\n{"state":[2,2,', 0.05, b'0,0],"n":1}\n', 0.2],
    # A daemon that connects and then says nothing: it's stuck, and the
    # controller it asked for doesn't outlive it.
    [b'{"open":3}\n', 2.0],
])
link = threading.Thread(target=origaitv_input.pad_link, args=(address, linked, stop), kwargs={"retry": 0.05, "refused": 0.3, "quiet": 0.4, "log": lambda line, flush=False: logged.append(line)})
link.start()
deadline = time.monotonic() + 10
while len(asked) < 5 and time.monotonic() < deadline:
    time.sleep(0.02)
stop.set()
link.join(3)
assert not link.is_alive(), "the connection's loop stops"
assert len(asked) >= 5, f"the helper asked {len(asked)} times"
assert asked[0][1].startswith("GET /api/pads HTTP/1.1\r\n") and "Upgrade: origaitv-pads\r\n" in asked[0][1] and "X-OrigaiTV-Screen: 1\r\n" in asked[0][1] and f"Host: 127.0.0.1:{address[1]}\r\n" in asked[0][1], asked[0][1]
# Refused, it asks again after a while, not at once.
assert asked[1][0] - asked[0][0] >= 0.3 and asked[2][0] - asked[1][0] >= 0.3, "a daemon that says no is asked again later"
assert [json.loads(line) for line in "".join(heard[0]).splitlines()] == [{"opened": 1}, {"took": [1, 5]}, {"opened": 2}, {"took": [2, 1]}], heard
assert [json.loads(line) for line in "".join(heard[1]).splitlines()] == [{"opened": 3}], heard
assert events() == [[(1, 0x130, 1)], [(1, 0x131, 1)]]
# However the connection ended, every controller went with it.
assert gone[:2] == [1, 2] and 3 in gone[2:] and linked.pads == {}, gone
assert any("it closed" in line for line in logged) and any("it went quiet" in line for line in logged), logged
assert not any("refused" in line for line in logged), "a switch that's off isn't news"
server.close()
print("ok - T26.1 every controller lasts as long as the daemon's connection: it ends or goes quiet, and they're gone")

os.environ.pop("ORIGAITV_URL", None)
os.environ.pop("ORIGAITV_PORT", None)
assert origaitv_input.daemon_address() == ("127.0.0.1", 3000)
os.environ["ORIGAITV_URL"] = "http://127.0.0.1:3999/"
assert origaitv_input.daemon_address() == ("127.0.0.1", 3999)
os.environ["ORIGAITV_URL"] = "http://example.com:3000/"
os.environ["ORIGAITV_PORT"] = "3005"
assert origaitv_input.daemon_address() == ("127.0.0.1", 3005), "nowhere but this box"
print("ok - the helper asks the daemon on this box")
PY
}

run || fail "the phone controller's tests pass"

node_test "$ROOT/test/origaitv/unit/phonepad.test.mts"
node_test "$ROOT/test/origaitv/unit/phonepad-vectors.test.mts"
