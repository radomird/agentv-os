#!/bin/bash

# Guards daemon/input.py, AgenTV's virtual input device (ADR-008): what it
# writes for a key, typed text, the pointer and a bad request. The uinput
# device itself needs the box (an image check and agentv selftest see it);
# here the events go to a stand-in.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

run() {
  python3 -I - "$ROOT/daemon" <<'PY'
import struct, sys
sys.path.insert(0, sys.argv[1])
import input as agentv_input

written = []
device = agentv_input.Device(written.append)

def events():
    out = []
    for chunk in written:
        for i in range(0, len(chunk), 24):
            _, _, kind, code, value = struct.unpack("llHHi", chunk[i:i + 24])
            if kind != 0:
                out.append((kind, code, value))
    written.clear()
    return out

device.handle({"key": "up"})
assert events() == [(1, 103, 1), (1, 103, 0)], "up"
print("ok - a key is a press and a release")

device.handle({"key": "back"})
assert events() == [(1, 1, 1), (1, 1, 0)], "back is Esc, AgenTV's back key"
device.handle({"key": "home"})
assert events() == [(1, 172, 1), (1, 172, 0)], "home is a remote's Home button"
print("ok - back is Esc (ADR-008), and home is a remote's Home button")

device.handle({"text": "Hi!"})
assert events() == [
    (1, 42, 1), (1, 35, 1), (1, 35, 0), (1, 42, 0),
    (1, 23, 1), (1, 23, 0),
    (1, 42, 1), (1, 2, 1), (1, 2, 0), (1, 42, 0),
], "Hi!"
print("ok - text is typed on a US layout, with Shift where it needs it")

# A character at a time, with a pause after each: all at once, a long text on
# a busy box overflows what the kernel keeps for the compositor.
log = []
paced = agentv_input.Device(lambda chunk: log.append("write"), lambda seconds: log.append(seconds))
paced.handle({"text": "aB"})
gap = agentv_input.TYPE_GAP
assert log == ["write", "write", gap, "write", "write", "write", "write", gap], log
assert 0.005 <= gap <= 0.05, gap
print("ok - typed text pauses after each character, so the compositor keeps up")

device.handle({"move": [5, -3]})
assert events() == [(2, 0, 5), (2, 1, -3)], "move"
device.handle({"click": "left"})
assert events() == [(1, 0x110, 1), (1, 0x110, 0)], "click"
device.handle({"scroll": -1})
assert events() == [(2, 8, -1)], "scroll"
print("ok - the pointer moves, clicks and scrolls")

for bad in ({"key": "nope"}, {"text": "é"}, {"click": "fourth"}, {"jump": 1}):
    try:
        device.handle(bad)
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad}")
assert events() == [], "nothing half-typed"
print("ok - a request it can't do is refused, with nothing half-typed")

# Nothing it types is logged or named in an error (ADR-032): the text can be
# a password, typed from the phone. Each error goes back to whoever asked,
# and from a service that's the journal.
secret = "hunter2-é-§"
for bad in ({"text": secret}, {"key": "é"}, {"hold": "§", "ms": 10}):
    try:
        device.handle(bad)
    except ValueError as error:
        said = str(error)
        assert "é" not in said and "§" not in said and "hunter2" not in said, f"the error names what was typed: {said}"
        continue
    raise AssertionError(f"accepted {bad}")
for line in (b'{"text": "hunter2-\\u00e9"}\n', b'{"text": "hunter2\n', b'{"key": "\\u00a7"}\n'):
    said = agentv_input.answer(device, line).decode()
    assert "hunter2" not in said and "\u00e9" not in said and "\u00a7" not in said, f"the answer names what was typed: {said}"
assert agentv_input.answer(device, b'{"key": "nope"}\n') == b"unknown key: nope\n", "a key's name is said when it's a word"
assert events() == [], "nothing half-typed"
print("ok - S1.7 an error never names what was typed, so no log can hold a password")

assert struct.calcsize("HHHH80sI") == 92 and agentv_input.UI_DEV_SETUP == 0x405C5503
print("ok - the device setup matches struct uinput_setup")

import time
started = time.monotonic()
device.handle({"hold": "back", "ms": 150})
assert time.monotonic() - started >= 0.15, "held for the time asked"
assert events() == [(1, 1, 1), (1, 1, 0)], "hold is one press and one release"
for bad in ({"hold": "back", "ms": 9000}, {"hold": "nope", "ms": 10}):
    try:
        device.handle(bad)
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad}")
print("ok - hold keeps a key down for a while, such as Back for Home (ADR-031)")

# A gamepad, as a FIFO: its guide button goes down and up, and A is pressed.
import os, tempfile, threading
fifo = os.path.join(tempfile.mkdtemp(), "pad-event-joystick")
os.mkfifo(fifo)
writer = os.open(fifo, os.O_RDWR)
guides = []
stop = threading.Event()
watcher = threading.Thread(target=agentv_input.watch_guide, args=(lambda: [fifo], lambda: guides.append(1), stop, 0.05))
watcher.start()
time.sleep(0.2)
for code, value in ((0x13C, 1), (0x13C, 0), (0x130, 1), (0x130, 0), (0x13C, 1)):
    os.write(writer, agentv_input.event(1, code, value) + agentv_input.event(0, 0, 0))
deadline = time.monotonic() + 2
while len(guides) < 2 and time.monotonic() < deadline:
    time.sleep(0.05)
stop.set()
watcher.join(2)
os.close(writer)
assert guides == [1, 1], f"the guide button went down twice, not {guides}"
assert not watcher.is_alive(), "the watcher stops"
print("ok - a gamepad's guide button is Home, and its other buttons aren't")
PY
}

run || fail "the virtual input device's tests pass"

# agentv input text, end to end through the device's socket, as a service on
# the box runs it: what's typed reaches the device, and nothing of it is in
# what the command prints, from the command line or from stdin.
export XDG_RUNTIME_DIR="$SCRATCH/run"
mkdir -p "$XDG_RUNTIME_DIR/agentv"
python3 -I - "$ROOT/daemon" "$SCRATCH/typed" <<'PY' &
import socket, struct, sys
sys.path.insert(0, sys.argv[1])
import input as agentv_input

typed = []
device = agentv_input.Device(typed.append)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(agentv_input.socket_path())
server.listen(4)
for _ in range(3):
    conn, _ = server.accept()
    with conn, conn.makefile("rwb") as stream:
        stream.write(agentv_input.answer(device, stream.readline()))
codes = [struct.unpack("llHHi", chunk[i:i + 24])[3] for chunk in typed for i in range(0, len(chunk), 24)]
open(sys.argv[2], "w").write(" ".join(map(str, codes)))
PY
server=$!
for _ in $(seq 50); do [[ -S $XDG_RUNTIME_DIR/agentv/input.sock ]] && break; sleep 0.1; done
out=$(AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-input" text "hunter2" 2>&1) || fail "agentv input text types" "$out"
out+=$(printf 'hunter2\n' | AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-input" text - 2>&1) || fail "agentv input text - types from stdin" "$out"
out+=$(AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-input" text "hunter2-é" 2>&1) && fail "an untypeable character is refused"
wait "$server"
[[ $out != *hunter2* && $out != *é* && $out == *"can't type one of those characters"* ]] ||
  fail "S1.7 agentv input never prints what it types" "$out"
[[ -s $SCRATCH/typed ]] || fail "what was typed reached the device"
pass "S1.7 agentv input types from its command line or stdin, and prints nothing of what it typed"

# agentv input move and click, the mouse, end to end the same way: what
# reaches the device's socket.
rm -f "$XDG_RUNTIME_DIR/agentv/input.sock"
python3 -I - "$ROOT/daemon" "$SCRATCH/pointer" <<'PY' &
import json, socket, sys
sys.path.insert(0, sys.argv[1])
import input as agentv_input

asked = []
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(agentv_input.socket_path())
server.listen(4)
for _ in range(3):
    conn, _ = server.accept()
    with conn, conn.makefile("rwb") as stream:
        asked.append(json.loads(stream.readline()))
        stream.write(b"ok\n")
open(sys.argv[2], "w").write(json.dumps(asked))
PY
server=$!
for _ in $(seq 50); do [[ -S $XDG_RUNTIME_DIR/agentv/input.sock ]] && break; sleep 0.1; done
for bad in "move 5" "move a b" "move 1 2 3" "click left right"; do
  # shellcheck disable=SC2086 # each case is words on purpose
  if AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-input" $bad >/dev/null 2>&1; then fail "agentv input $bad is refused"; fi
done
AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-input" move -4000 -4000 || fail "agentv input move sends the move"
AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-input" click || fail "agentv input click sends a left click"
AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-input" click right || fail "agentv input click right sends a right click"
wait "$server"
[[ $(cat "$SCRATCH/pointer") == '[{"move": [-4000, -4000]}, {"click": "left"}, {"click": "right"}]' ]] ||
  fail "the pointer's requests reach the device" "$(cat "$SCRATCH/pointer")"
pass "agentv input moves the pointer and clicks, for the corner's Home (ADR-031)"
