#!/bin/bash

# Guards the sudo that root lends to one command (H1): bin/agentv-sudo-lend
# and its stand-in for sudo, bin/agentv-sudo-shim. An update from the TV lends
# it to the migrations, and first boot to Omarchy's splash command, where a
# rule in /etc/sudoers.d used to make every process of the owner's root.
#
# Most of it runs against a stand-in for the real sudo, so it runs anywhere.
# The last part needs root, runuser and a working sudo: it lends the real one
# to another account and tries to reach it from outside. The image layer
# checks the same on a box.

# shellcheck disable=SC2016 # the single quotes hold commands that run later, inside the lending
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

lend="$ROOT/bin/agentv-sudo-lend"
shim="$ROOT/bin/agentv-sudo-shim"
asked="$SCRATCH/asked"
mkdir -p "$SCRATCH/first" "$SCRATCH/work dir"
ln -s "$shim" "$SCRATCH/first/sudo"

# The real sudo's stand-in: one argument a line, then where it ran and with
# what, then the command itself.
cat >"$SCRATCH/real-sudo" <<SH
#!/bin/bash
{
  printf 'arg<%s>\n' "\$@"
  echo "in \$PWD HOME=\$HOME PATH=\$PATH SECRET=\${SECRET:-none}"
} >>"$asked"
while [[ \${1:-} == -* ]]; do
  [[ \$1 == "-u" ]] && shift
  shift
done
exec "\$@"
SH
chmod +x "$SCRATCH/real-sudo"
export AGENTV_SUDO_REAL="$SCRATCH/real-sudo"
# The kernel's setting for who may trace whom, here a file. It's 1 on a box.
echo 1 >"$SCRATCH/ptrace_scope"
export AGENTV_PTRACE_SCOPE_FILE="$SCRATCH/ptrace_scope"

# lent <bash script> [arguments]: runs it with a lent sudo first in its PATH.
lent() {
  : >"$asked"
  SECRET=the-callers PATH="$SCRATCH/first:$PATH" "$lend" -- "$BASH" -c "$@" 2>"$SCRATCH/lend-says"
}

# What goes in comes out: input, output, errors and how it ended.
out=$(lent 'printf "line one\nline two\n" | sudo sh -c "cat; echo oops >&2; exit 7" 2>"$1/errors"; echo "ended $?"' _ "$SCRATCH")
[[ $out == $'line one\nline two\nended 7' ]] || fail "the lent sudo passes input and output through, and how the command ended" "$out"
[[ $(cat "$SCRATCH/errors") == "oops" ]] || fail "the lent sudo passes errors through" "$(cat "$SCRATCH/errors")"
pass "H1 the lent sudo passes input, output, errors and the exit status through"

# Every argument as it was given: options of sudo's, spaces, quotes, a
# newline, an empty one, and letters outside ASCII.
lent 'sudo -n -u someone -- printf "%s|" "two words" "it'"'"'s \"quoted\"" "a
b" "" "žluťoučký"' >"$SCRATCH/out"
[[ $(cat "$SCRATCH/out") == $'two words|it\'s "quoted"|a\nb||žluťoučký|' ]] || fail "arguments reach the command as they were given" "$(cat "$SCRATCH/out")"
{ grep -qx "arg<-n>" "$asked" && grep -qx "arg<-u>" "$asked" && grep -qx "arg<someone>" "$asked" && grep -qx "arg<-->" "$asked"; } ||
  fail "sudo's own options reach the real sudo" "$(cat "$asked")"
grep -qx "arg<>" "$asked" || fail "an empty argument stays one" "$(cat "$asked")"
pass "H1 the lent sudo passes every argument through as it was given, sudo's own options too"

# The real sudo runs in the caller's folder, with root's environment and
# none of the caller's.
(cd "$SCRATCH/work dir" && lent 'sudo pwd') >"$SCRATCH/out"
[[ $(cat "$SCRATCH/out") == "$SCRATCH/work dir" ]] || fail "the command runs in the folder sudo was called from" "$(cat "$SCRATCH/out")"
grep -qx "in $SCRATCH/work dir HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/bin SECRET=none" "$asked" ||
  fail "the real sudo gets a fixed environment, with nothing of the caller's" "$(cat "$asked")"
pass "H1 the real sudo runs where it was called from, with a fixed environment of root's"

# Two at once, as in sudo a | sudo b, and a few in a row.
out=$(lent 'sudo echo one | sudo tr a-z A-Z; for n in 1 2 3; do sudo echo "$n"; done')
[[ $out == $'ONE\n1\n2\n3' ]] || fail "two sudo calls in one pipeline both go through" "$out"
pass "the lent sudo serves a pipeline of sudo calls, and one call after another"

# It ends the way the command did, and says what it ran.
ended=0
lent 'sudo true; exit 5' || ended=$?
[[ $ended == 5 ]] || fail "the lending ends with its command's status" "$ended"
grep -qx "agentv-sudo-lend: sudo true" "$SCRATCH/lend-says" || fail "the lending says what it ran through sudo, for the update's log" "$(cat "$SCRATCH/lend-says")"
pass "the lending ends the way its command did, and logs each sudo call"

# Outside the lending there's no sudo: no socket, the wrong number, or a
# file that isn't the socket.
if out=$(env -u AGENTV_SUDO_FD "$shim" true 2>&1); then fail "H1 the stand-in refuses with no lending"; fi
[[ $out == "sudo: no sudo has been lent to this command" ]] || fail "it says why" "$out"
if AGENTV_SUDO_FD=200 "$shim" true 2>/dev/null; then fail "H1 the stand-in refuses with only the number"; fi
if AGENTV_SUDO_FD=9 "$shim" true 9<"$SCRATCH/real-sudo" 2>/dev/null; then fail "H1 the stand-in refuses a file that isn't the lent socket"; fi
if AGENTV_SUDO_FD=9 "$shim" true 9<>/dev/null 2>/dev/null; then fail "H1 the stand-in refuses /dev/null"; fi
pass "H1 outside the lending the stand-in for sudo refuses"

# The socket has no path: opening it through /proc fails, for the command
# itself and for a process that was never part of it.
mkfifo "$SCRATCH/fifo"
lent 'echo $$ >"$0/pid"; exec 8<>"$0/fifo"; touch "$0/ready"; read -r _ <&8' "$SCRATCH" &
lending=$!
for _ in $(seq 100); do [[ -f $SCRATCH/ready ]] && break; python3 -c 'import time; time.sleep(0.05)'; done
pid=$(cat "$SCRATCH/pid")
[[ -S /proc/$pid/fd/200 ]] || fail "the command holds the lent socket as file 200" "$(ls -l "/proc/$pid/fd" 2>&1)"
if (exec 7<>"/proc/$pid/fd/200") 2>/dev/null; then fail "H1 a process outside the command can't open the lent socket by its path"; fi
if python3 -c 'import os, sys; os.open(sys.argv[1], os.O_RDWR)' "/proc/$pid/fd/200" 2>/dev/null; then fail "H1 not from Python either"; fi
if { AGENTV_SUDO_FD=7 "$shim" true 7<"/proc/$pid/fd/200"; } 2>/dev/null; then fail "H1 and the stand-in gets nowhere with it"; fi
echo go >"$SCRATCH/fifo"
wait "$lending" || true
pass "H1 a process outside the command can't reach the lent sudo: the socket has no path to open"

# When the command ends, so does the lending, also for what it left running.
lent '(read -r _ <"$0/fifo"; sudo true; echo "late $?" >"$0/late") >/dev/null 2>&1 &' "$SCRATCH"
echo go >"$SCRATCH/fifo"
for _ in $(seq 100); do [[ -f $SCRATCH/late ]] && break; python3 -c 'import time; time.sleep(0.05)'; done
[[ $(cat "$SCRATCH/late") == "late 1" ]] || fail "H1 a process the command left behind has no sudo once it ends" "$(cat "$SCRATCH/late" 2>&1)"
[[ ! -s $asked ]] || fail "H1 and the real sudo never ran for it" "$(cat "$asked")"
pass "H1 the lending ends with its command, also for a process the command left running"

# The other way to a socket is tracing a process that holds it. With the
# kernel set to let any process of an account trace another, the lending
# sets it to "only what you started" for as long as it lasts.
echo 0 >"$SCRATCH/ptrace_scope"
during=$(lent 'cat "$0/ptrace_scope"' "$SCRATCH")
[[ $during == 1 && $(cat "$SCRATCH/ptrace_scope") == 0 ]] || fail "H1 while it lends, a process can only be traced by what started it, and the setting goes back after" "$during, then $(cat "$SCRATCH/ptrace_scope")"
echo 2 >"$SCRATCH/ptrace_scope"
during=$(lent 'cat "$0/ptrace_scope"' "$SCRATCH")
[[ $during == 2 && $(cat "$SCRATCH/ptrace_scope") == 2 ]] || fail "a stricter setting is left alone" "$during, then $(cat "$SCRATCH/ptrace_scope")"
echo 1 >"$SCRATCH/ptrace_scope"
pass "H1 while sudo is lent, the command's processes can't be traced by another process of the account"

# --- The real thing: root lends the real sudo to another account -------------

if (( EUID != 0 )) || ! type -P runuser >/dev/null || ! sudo -n true 2>/dev/null || ! getent passwd nobody >/dev/null; then
  echo "skip - the real sudo, lent by root to another account (needs root, runuser and sudo)"
  exit 0
fi
unset AGENTV_SUDO_REAL AGENTV_PTRACE_SCOPE_FILE
other=nobody
# A folder the other account can reach, as /run is on a box.
real=$(mktemp -d /tmp/agentv-sudo-lend-test.XXXXXX)
trap 'rm -rf "$SCRATCH" "$real"' EXIT
chmod 755 "$real"
mkdir "$real/first" "$real/theirs"
ln -s "$shim" "$real/first/sudo"
chown "$other" "$real/theirs"
if ! runuser -u "$other" -- "$shim" --help >/dev/null 2>&1 && ! runuser -u "$other" -- test -x "$shim"; then
  echo "skip - the real sudo, lent by root to another account ($other can't reach this checkout)"
  exit 0
fi

# On its own the other account has no sudo.
if runuser -u "$other" -- env -i PATH=/usr/bin:/bin sudo -n true 2>/dev/null; then
  echo "skip - the real sudo, lent by root to another account ($other already has sudo here)"
  exit 0
fi
out=$("$lend" -- runuser -u "$other" -- env -i PATH="$real/first:/usr/bin:/bin" AGENTV_SUDO_FD=200 "$BASH" --noprofile --norc -c \
  'id -un; sudo id -un; sudo -u "$1" id -un; sudo -n true; echo "ended $?"; echo in | sudo tee "$2/theirs/written" >/dev/null; stat -c %U "$2/theirs/written"' \
  _ "$other" "$real" 2>/dev/null)
[[ $out == "$other"$'\nroot\n'"$other"$'\nended 0\nroot' ]] || fail "H1 root lends the real sudo to another account's command" "$out"
pass "H1 as root: another account's command is root through the lent sudo, with sudo's own options"

# While that command runs, the same account from outside it gets nothing:
# not through sudo, not through the stand-in, not by the socket's path.
mkfifo "$real/theirs/fifo"
chown "$other" "$real/theirs/fifo"
"$lend" -- runuser -u "$other" -- env -i PATH="$real/first:/usr/bin:/bin" AGENTV_SUDO_FD=200 "$BASH" --noprofile --norc -c \
  'echo $$ >"$0/theirs/pid"; exec 8<>"$0/theirs/fifo"; touch "$0/theirs/ready"; read -r _ <&8' "$real" 2>/dev/null &
lending=$!
for _ in $(seq 100); do [[ -f $real/theirs/ready ]] && break; python3 -c 'import time; time.sleep(0.05)'; done
pid=$(cat "$real/theirs/pid")
out=$(runuser -u "$other" -- env -i PATH="$real/first:/usr/bin:/bin" AGENTV_SUDO_FD=200 "$BASH" --noprofile --norc -c '
  sudo true 2>/dev/null; echo "stand-in $?"
  /usr/bin/sudo -n true 2>/dev/null; echo "sudo $?"
  [[ -S /proc/$1/fd/200 ]] && echo "sees the socket"
  if (exec 7<>"/proc/$1/fd/200") 2>/dev/null; then echo "opened"; else echo "refused"; fi' _ "$pid" 2>&1)
echo go >"$real/theirs/fifo"
wait "$lending" || true
[[ $out == $'stand-in 1\nsudo 1\nsees the socket\nrefused' ]] || fail "H1 the same account, outside the command, gets no sudo while it's lent" "$out"
pass "H1 as root: while sudo is lent, another process of the same account can't use it or open its socket"
