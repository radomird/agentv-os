#!/bin/bash

# Guards the sandbox of AgenTV's daemon (system/agentv-daemon.service). It
# faces the home network and runs apps' workers, so its unit keeps the
# kernel's knobs away from it. And it keeps out the settings the daemon
# can't live with: the box check reads the GPU through /dev/dri, an app's
# worker gets namespaces of its own, and Node's JIT writes code it then runs.
# The image check t15-units reads the real score on a box.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

unit="$ROOT/system/agentv-daemon.service"

for line in DynamicUser=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes NoNewPrivileges=yes; do
  grep -qx "$line" "$unit" || fail "the daemon's unit keeps $line"
done
pass "the daemon's unit keeps the sandbox it had"

for line in ProtectKernelTunables=yes ProtectKernelModules=yes ProtectKernelLogs=yes ProtectControlGroups=yes \
  ProtectHostname=yes ProtectProc=invisible LockPersonality=yes RestrictRealtime=yes \
  RestrictSUIDSGID=yes SystemCallArchitectures=native; do
  grep -qx "$line" "$unit" || fail "the daemon's unit has $line"
done
pass "the daemon gets none of the kernel's knobs, and sees no other user's processes"

families=$(sed -n 's/^RestrictAddressFamilies=//p' "$unit")
[[ $families == "AF_UNIX AF_INET AF_INET6 AF_NETLINK" ]] ||
  fail "the daemon opens only local, IPv4, IPv6 and netlink sockets" "$families"
pass "the daemon opens only local, IPv4, IPv6 and netlink sockets"

# Each of these would break something the daemon does. Adding one means
# changing the daemon first, and this test with it. ProtectClock= is here
# because it brings a DeviceAllow= of its own, which closes /dev/dri to the
# box check the way PrivateDevices= would.
for key in PrivateDevices ProtectClock DeviceAllow DevicePolicy RestrictNamespaces PrivateUsers MemoryDenyWriteExecute SystemCallFilter PrivateNetwork; do
  grep -q "^$key=" "$unit" && fail "the daemon's unit has no $key=, which it can't live with yet"
done
pass "nothing the box check, an app's worker or Node's JIT needs is taken away"

# One setting per line, each once: a second line would quietly win.
dupes=$(grep -E '^[A-Z][A-Za-z]+=' "$unit" | cut -d= -f1 | grep -vxE 'Environment|ExecStart' | sort | uniq -d)
[[ -z $dupes ]] || fail "no setting is given twice" "$dupes"
pass "no setting is given twice"
