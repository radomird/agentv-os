#!/usr/bin/env python3
"""AgenTV's virtual input device (ADR-008).

The phone's d-pad and keyboard, and later the gamepad mapping, reach the TV
through one virtual keyboard and pointer, "AgenTV remote", so they work in
every window: the home screen, a service's page, Steam. It's a uinput device
made by the person logged in on the screen, which the udev rule in
system/70-agentv-uinput.rules allows, the way Steam's own rule does for Steam
Input. Nobody else on the box can use it.

  input.py serve              make the device and take requests on
                              $XDG_RUNTIME_DIR/agentv/input.sock
  input.py key <name>...      press and release keys: up, down, left, right,
                              enter, back, home, playpause, a, 1, ...
  input.py hold <name> <s>    press a key, hold it for s seconds, release it
  input.py text <text>        type text (US layout)
  input.py move <dx> <dy>     move the pointer; pushed far enough, it stops
                              in a corner, such as the one with Home
  input.py click [button]     click: left, the default, right or middle

A request is one JSON line: {"key": "up"}, {"hold": "back", "ms": 1200},
{"text": "hello"}, {"move": [dx, dy]}, {"click": "left"} or {"scroll": n}.
The answer is "ok" or an error, on one line.

It also watches the gamepads for their guide button, which is Home
(ADR-031), and tells the screen daemon. A gamepad's other buttons reach
the window in front as they are. Standard library only.
"""

import fcntl
import glob
import json
import os
import re
import select
import socket
import struct
import sys
import threading
import time

# linux/input-event-codes.h
EV_SYN, EV_KEY, EV_REL = 0x00, 0x01, 0x02
SYN_REPORT = 0
REL_X, REL_Y, REL_WHEEL = 0x00, 0x01, 0x08
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
BTN_MODE = 0x13C
EVENT_SIZE = struct.calcsize("llHHi")
KEY_LEFTSHIFT = 42
BUS_VIRTUAL = 0x06

# linux/uinput.h
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_DEV_SETUP = 0x405C5503
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

NAME = b"AgenTV remote"

KEYS = {
    "esc": 1, "back": 1, "backspace": 14, "tab": 15, "enter": 28, "space": 57,
    "up": 103, "left": 105, "right": 106, "down": 108,
    "pageup": 104, "pagedown": 109, "end": 107, "delete": 111,
    # KEY_HOMEPAGE, what a remote's Home button sends. A keyboard's Home key
    # (KEY_HOME, 102) is "home-key".
    "home": 172, "home-key": 102,
    "mute": 113, "volumedown": 114, "volumeup": 115,
    "playpause": 164, "stop": 166, "previous": 165, "next": 163,
    "f11": 87,
}
for i, letter in enumerate("qwertyuiop"):
    KEYS[letter] = 16 + i
for i, letter in enumerate("asdfghjkl"):
    KEYS[letter] = 30 + i
for i, letter in enumerate("zxcvbnm"):
    KEYS[letter] = 44 + i
for i, digit in enumerate("1234567890"):
    KEYS[digit] = 2 + i

# Characters to (key, shift), on a US layout.
CHARS = {c: (c, False) for c in "abcdefghijklmnopqrstuvwxyz0123456789"}
CHARS.update({c.upper(): (c, True) for c in "abcdefghijklmnopqrstuvwxyz"})
CHARS.update({" ": ("space", False), "\n": ("enter", False), "\t": ("tab", False)})
PUNCTUATION = {
    "-": (12, False), "_": (12, True), "=": (13, False), "+": (13, True),
    "[": (26, False), "{": (26, True), "]": (27, False), "}": (27, True),
    ";": (39, False), ":": (39, True), "'": (40, False), '"': (40, True),
    "`": (41, False), "~": (41, True), "\\": (43, False), "|": (43, True),
    ",": (51, False), "<": (51, True), ".": (52, False), ">": (52, True),
    "/": (53, False), "?": (53, True),
    "!": (2, True), "@": (3, True), "#": (4, True), "$": (5, True), "%": (6, True),
    "^": (7, True), "&": (8, True), "*": (9, True), "(": (10, True), ")": (11, True),
}
BUTTONS = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}


def event(kind, code, value):
    """One struct input_event, as uinput reads it on 64-bit Linux."""
    now = time.time()
    return struct.pack("llHHi", int(now), int((now % 1) * 1_000_000), kind, code, value)


def code_of_char(char):
    if char in CHARS:
        key, shift = CHARS[char]
        return KEYS[key], shift
    if char in PUNCTUATION:
        return PUNCTUATION[char]
    raise ValueError(f"can't type {char!r} yet")


class Device:
    """Writes key and pointer events. The writer is the uinput file, or a
    stand-in in the unit tests."""

    def __init__(self, write):
        self.write = write

    def emit(self, *events):
        self.write(b"".join(events) + event(EV_SYN, SYN_REPORT, 0))

    def tap(self, code, shift=False):
        if shift:
            self.emit(event(EV_KEY, KEY_LEFTSHIFT, 1))
        self.emit(event(EV_KEY, code, 1))
        self.emit(event(EV_KEY, code, 0))
        if shift:
            self.emit(event(EV_KEY, KEY_LEFTSHIFT, 0))

    def key(self, name):
        if name not in KEYS:
            raise ValueError(f"unknown key: {name}")
        self.tap(KEYS[name])

    def hold(self, name, ms):
        if name not in KEYS:
            raise ValueError(f"unknown key: {name}")
        if not 0 <= ms <= 5000:
            raise ValueError("hold for up to 5000 ms")
        self.emit(event(EV_KEY, KEYS[name], 1))
        time.sleep(ms / 1000)
        self.emit(event(EV_KEY, KEYS[name], 0))

    def text(self, text):
        codes = [code_of_char(c) for c in text]
        for code, shift in codes:
            self.tap(code, shift)

    def move(self, dx, dy):
        self.emit(event(EV_REL, REL_X, int(dx)), event(EV_REL, REL_Y, int(dy)))

    def click(self, button):
        if button not in BUTTONS:
            raise ValueError(f"unknown button: {button}")
        self.emit(event(EV_KEY, BUTTONS[button], 1))
        self.emit(event(EV_KEY, BUTTONS[button], 0))

    def scroll(self, amount):
        self.emit(event(EV_REL, REL_WHEEL, int(amount)))

    def handle(self, request):
        if "key" in request:
            self.key(str(request["key"]))
        elif "hold" in request:
            self.hold(str(request["hold"]), int(request.get("ms", 1000)))
        elif "text" in request:
            self.text(str(request["text"]))
        elif "move" in request:
            self.move(*request["move"])
        elif "click" in request:
            self.click(str(request["click"]))
        elif "scroll" in request:
            self.scroll(request["scroll"])
        else:
            raise ValueError("a request is key, hold, text, move, click or scroll")


def create():
    """Makes the uinput device and returns its file descriptor."""
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    for kind in (EV_KEY, EV_REL):
        fcntl.ioctl(fd, UI_SET_EVBIT, kind)
    for code in sorted(set(KEYS.values()) | {KEY_LEFTSHIFT} | {c for c, _ in PUNCTUATION.values()} | set(BUTTONS.values())):
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    for code in (REL_X, REL_Y, REL_WHEEL):
        fcntl.ioctl(fd, UI_SET_RELBIT, code)
    # struct uinput_setup: struct input_id, name[80], ff_effects_max.
    fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack("HHHH80sI", BUS_VIRTUAL, 0, 1, 1, NAME, 0))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    return fd


def socket_path(name="input.sock"):
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "agentv", name)


def gamepads():
    """The gamepads plugged in now. The seat's user can read them (udev's
    uaccess), which is how a browser's gamepad support works too."""
    return sorted(glob.glob("/dev/input/by-id/*-event-joystick"))


def watch_guide(find, on_guide, stop, rescan=3.0):
    """Calls on_guide each time a gamepad's guide button goes down, until
    stop is set. find lists the devices; it's asked again every few seconds,
    so a gamepad plugged in later counts too."""
    fds = {}
    scanned = 0.0
    while not stop.is_set():
        if time.monotonic() - scanned >= rescan:
            scanned = time.monotonic()
            for path in find():
                if path not in fds:
                    try:
                        fds[path] = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                    except OSError:
                        pass
        if not fds:
            stop.wait(min(rescan, 0.5))
            continue
        ready, _, _ = select.select(list(fds.values()), [], [], 0.5)
        for fd in ready:
            try:
                data = os.read(fd, EVENT_SIZE * 64)
            except BlockingIOError:
                continue
            except OSError:
                data = b""
            if not data:
                # Unplugged.
                for path, open_fd in list(fds.items()):
                    if open_fd == fd:
                        del fds[path]
                os.close(fd)
                continue
            for i in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                _, _, kind, code, value = struct.unpack_from("llHHi", data, i)
                if kind == EV_KEY and code == BTN_MODE and value == 1:
                    on_guide()
    for fd in fds.values():
        os.close(fd)


def screen_home():
    """Asks the screen daemon for Home, as the guide button. In a game, the
    guide button is the game's own, so the daemon leaves it."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(5)
    try:
        client.connect(socket_path("screen.sock"))
        client.sendall(b'{"cmd":"home","from":"guide"}\n')
        client.recv(4096)
    except OSError as error:
        print(f"agentv input: Home didn't reach the screen daemon: {error}", flush=True)
    finally:
        client.close()


def serve():
    fd = create()
    device = Device(lambda data: os.write(fd, data))
    path = socket_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(8)
    print(f"agentv input: {NAME.decode()} is ready on {path}", flush=True)
    stop = threading.Event()
    threading.Thread(target=watch_guide, args=(gamepads, screen_home, stop), daemon=True).start()
    try:
        while True:
            conn, _ = server.accept()
            with conn, conn.makefile("rwb") as stream:
                line = stream.readline()
                try:
                    device.handle(json.loads(line))
                    stream.write(b"ok\n")
                except (ValueError, TypeError, KeyError) as error:
                    stream.write(f"{error}\n".encode())
    finally:
        stop.set()
        fcntl.ioctl(fd, UI_DEV_DESTROY)
        os.close(fd)


def send(request):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(socket_path())
    except OSError:
        print("agentv input: the virtual input device isn't running (no TV session)", file=sys.stderr)
        return 2
    with client, client.makefile("rwb") as stream:
        stream.write(json.dumps(request).encode() + b"\n")
        stream.flush()
        answer = stream.readline().decode().strip()
    if answer != "ok":
        print(f"agentv input: {answer}", file=sys.stderr)
        return 1
    return 0


def main(args):
    if args[:1] == ["serve"]:
        serve()
        return 0
    if args[:1] == ["key"] and len(args) > 1:
        for name in args[1:]:
            status = send({"key": name})
            if status:
                return status
        return 0
    if args[:1] == ["hold"] and len(args) == 3:
        try:
            ms = round(float(args[2]) * 1000)
        except ValueError:
            ms = -1
        return send({"hold": args[1], "ms": ms})
    if args[:1] == ["text"] and len(args) == 2:
        return send({"text": args[1]})
    if args[:1] == ["move"] and len(args) == 3 and all(re.fullmatch(r"-?\d{1,5}", a) for a in args[1:]):
        return send({"move": [int(args[1]), int(args[2])]})
    if args[:1] == ["click"] and len(args) <= 2:
        return send({"click": args[1] if len(args) == 2 else "left"})
    print(__doc__.split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
