#!/bin/bash

# Guards the TV found and woken (T25.1's unit half): the box id, the wake
# fields and the daemon's hand-over with Node's own test runner, then
# origaitv-announce-set, which writes Avahi's file as root. It takes an id of
# 32 hex digits, a port and a name and nothing else, adds the package's
# version, writes the record with the name, the version and the id and
# nothing more, and removes the file when told to stop or handed an id or a
# port that isn't one, without echoing what was dropped. The drop goes either
# way. The name is free text (T28.5's unit half): it comes out escaped and as
# typed, with nothing filled in by Avahi, and one the helper doesn't take is
# announced as OrigaiTV. origaitv-announce.path
# watches the daemon's drop, the service runs as root with two folders to
# write, first boot opens mDNS to the home network only, and boxes installed
# before get both from a migration.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/announce.test.mts"
node_test "$ROOT/test/origaitv/unit/name.test.mts"

ID=0123456789abcdef0123456789abcdef
export ORIGAITV_ANNOUNCE_DROP="$SCRATCH/drop/announce.json" ORIGAITV_ANNOUNCE_FILE="$SCRATCH/avahi/origaitv.service" ORIGAITV_PATH="$SCRATCH/package"
mkdir -p "$SCRATCH/drop" "$SCRATCH/avahi"
fake_origaitv_path "$ORIGAITV_PATH"
announce() {
  "$ROOT/bin/origaitv-announce-set" >"$SCRATCH/out" 2>&1
}
hand() {
  printf '%s' "$1" >"$ORIGAITV_ANNOUNCE_DROP"
}

announce || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -s $SCRATCH/out && ! -e $ORIGAITV_ANNOUNCE_FILE ]] || fail "and writes nothing" "$(cat "$SCRATCH/out")"
pass "with nothing handed over, it does nothing"

# The whole of Avahi's file, with this between the name's tags.
file_with() {
  cat <<XML
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!-- Written by origaitv-announce-set, each time OrigaiTV's daemon starts. -->
<service-group>
  <name replace-wildcards="no">$1</name>
  <service protocol="ipv4">
    <type>_origaitv._tcp</type>
    <port>3001</port>
    <txt-record>id=$ID</txt-record>
    <txt-record>version=0.1.0</txt-record>
  </service>
</service-group>
XML
}
GOOD="{\"on\":true,\"id\":\"$ID\",\"port\":3001,\"name\":\"Living room\"}"

hand "$GOOD"
announce || fail "an id, a port and a name are taken" "$(cat "$SCRATCH/out")"
[[ $(cat "$ORIGAITV_ANNOUNCE_FILE") == "$(file_with "Living room")" ]] || fail "T25.1 Avahi's file has the type, the port, the name, the version and the id, and nothing more" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
[[ ! -e $ORIGAITV_ANNOUNCE_DROP && -z $(ls -A "$SCRATCH/drop") ]] || fail "the drop is gone, with nothing left beside it" "$(ls -A "$SCRATCH/drop")"
[[ $(ls -A "$SCRATCH/avahi") == "origaitv.service" ]] || fail "and nothing else is left in Avahi's folder" "$(ls -A "$SCRATCH/avahi")"
[[ -r $ORIGAITV_ANNOUNCE_FILE && ! -x $ORIGAITV_ANNOUNCE_FILE ]] || fail "Avahi can read it"
[[ $(cat "$SCRATCH/out") == "origaitv-announce-set: the TV is announced on the home network, on port 3001" ]] || fail "it says so, and nothing else" "$(cat "$SCRATCH/out")"
if type -P python3 >/dev/null; then
  python3 -c 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])' "$ORIGAITV_ANNOUNCE_FILE" || fail "the file is well-formed XML"
fi
pass "T25.1 an id, a port and a name become Avahi's file: _origaitv._tcp on the phones' port, with the name, the version and the id"

# The same again changes nothing, so Avahi isn't made to read it twice.
touch -t 202601010000 "$ORIGAITV_ANNOUNCE_FILE"
before=$(ls -l "$ORIGAITV_ANNOUNCE_FILE")
hand "$GOOD"
announce || fail "the same again is fine" "$(cat "$SCRATCH/out")"
[[ $(ls -l "$ORIGAITV_ANNOUNCE_FILE") == "$before" && ! -s $SCRATCH/out && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "the same again leaves the file as it is, and takes the drop" "$(cat "$SCRATCH/out")"
# A new version, after an update, is written.
printf 'ORIGAITV_VERSION=1.0.0.r3.gabc1234\n' >"$ORIGAITV_PATH/settings"
hand "$GOOD"
announce || fail "a new version is taken" "$(cat "$SCRATCH/out")"
grep -qx "    <txt-record>version=1.0.0.r3.gabc1234</txt-record>" "$ORIGAITV_ANNOUNCE_FILE" || fail "the record follows the installed version" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
# The version is the package's. One that isn't a version, or no settings at
# all, as in a checkout, says dev.
printf 'ORIGAITV_VERSION=1.0</txt-record><txt-record>x=y\n' >"$ORIGAITV_PATH/settings"
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001,\"name\":\"Living room\",\"version\":\"9.9.9\"}"
announce || fail "settings with an odd version are fine" "$(cat "$SCRATCH/out")"
grep -qx "    <txt-record>version=dev</txt-record>" "$ORIGAITV_ANNOUNCE_FILE" || fail "a version that isn't one says dev, and the drop's own isn't taken" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
rm "$ORIGAITV_PATH/settings"
hand "$GOOD"
announce || fail "a checkout is fine" "$(cat "$SCRATCH/out")"
grep -qx "    <txt-record>version=dev</txt-record>" "$ORIGAITV_ANNOUNCE_FILE" || fail "a checkout says dev" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
fake_origaitv_path "$ORIGAITV_PATH"
pass "the same again leaves the file alone, and the version is the package's own, never the drop's"

hand '{"on":false}'
announce || fail "told to stop, it stops" "$(cat "$SCRATCH/out")"
[[ ! -e $ORIGAITV_ANNOUNCE_FILE && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "T25.1 off, the file is gone, and so is the drop"
grep -qx "origaitv-announce-set: the TV isn't announced on the home network any more" "$SCRATCH/out" || fail "it says so" "$(cat "$SCRATCH/out")"
hand '{"on":false}'
announce || fail "told to stop with nothing there is fine" "$(cat "$SCRATCH/out")"
[[ ! -s $SCRATCH/out && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "and says nothing" "$(cat "$SCRATCH/out")"
pass "T25.1 told to stop, it takes the file away, and with none there it does nothing"

# --- The name (T28.5) --------------------------------------------------------
#
# The name is what a person typed, handed over by a daemon that faces the
# network, and root writes it into a file. So: what's between the tags is
# escaped, an XML parser reads the name back as it was typed, Avahi is told
# to fill nothing in, and nothing a name holds adds a tag or a line.

# with_name <the name as JSON, quotes and all>: a drop that's right, with it.
with_name() {
  printf '{"on":true,"id":"%s","port":3001,"name":%s}' "$ID" "$1"
}
# The name an XML parser reads out of Avahi's file, and that the file still
# has one name, one service and two TXT entries, and nothing else that
# announces.
read_back() {
  python3 -c '
import sys, xml.dom.minidom
doc = xml.dom.minidom.parse(sys.argv[1])
count = lambda tag: len(doc.getElementsByTagName(tag))
names = doc.getElementsByTagName("name")
assert count("name") == 1 and names[0].getAttribute("replace-wildcards") == "no", "one name, with nothing filled in"
assert [count(tag) for tag in ("service-group", "service", "type", "port", "txt-record", "host-name", "domain-name", "subtype")] == [1, 1, 1, 1, 2, 0, 0, 0], "and nothing more"
sys.stdout.buffer.write("".join(node.data for node in names[0].childNodes).encode())
' "$ORIGAITV_ANNOUNCE_FILE"
}
SAID_SO="origaitv-announce-set: the drop's name isn't one to announce, so the TV is announced as OrigaiTV"

# taken <the name as JSON> <what's between the tags> [<the name as typed>]
taken() {
  local json=$1 escaped=$2 typed=${3:-$2}
  printf '<service-group/>\n' >"$ORIGAITV_ANNOUNCE_FILE"
  hand "$(with_name "$json")"
  announce || fail "the name $json is taken" "$(cat "$SCRATCH/out")"
  [[ $(cat "$ORIGAITV_ANNOUNCE_FILE") == "$(file_with "$escaped")" ]] || fail "T28.5 the name $json is written as $escaped, and nothing else in the file moves" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
  [[ $(cat "$SCRATCH/out") == "origaitv-announce-set: the TV is announced on the home network, on port 3001" ]] || fail "the name $json: it only says the TV is announced" "$(cat "$SCRATCH/out")"
  [[ ! -e $ORIGAITV_ANNOUNCE_DROP && -z $(ls -A "$SCRATCH/drop") ]] || fail "the name $json: the drop is gone" "$(ls -A "$SCRATCH/drop")"
  if type -P python3 >/dev/null; then
    [[ $(read_back) == "$typed" ]] || fail "T28.5 the name $json reads back as it was typed" "$(read_back 2>&1 || true)"
  fi
}
taken '"Living room"' 'Living room'
taken '"Tom & Jerry"' 'Tom &amp; Jerry' 'Tom & Jerry'
taken '"<Den>"' '&lt;Den&gt;' '<Den>'
taken '"a \"b\" c"' 'a &quot;b&quot; c' 'a "b" c'
taken "\"Ana's room\"" 'Ana&#39;s room' "Ana's room"
taken '"& < > \" '\''"' '&amp; &lt; &gt; &quot; &#39;' '& < > " '\'
taken '"&amp; &#x41; &lt;"' '&amp;amp; &amp;#x41; &amp;lt;' '&amp; &#x41; &lt;'
taken '"a]]>b"' 'a]]&gt;b' 'a]]>b'
taken '"<!-- x --> <?y z?>"' '&lt;!-- x --&gt; &lt;?y z?&gt;' '<!-- x --> <?y z?>'
taken '"</name><host-name>x.local</host-name>"' '&lt;/name&gt;&lt;host-name&gt;x.local&lt;/host-name&gt;' '</name><host-name>x.local</host-name>'
taken '"</name></service-group>"' '&lt;/name&gt;&lt;/service-group&gt;' '</name></service-group>'
pass "T28.5 a name with &, <, > and both quotes is escaped, reads back as typed, and adds no tag"

# Avahi fills nothing in, the shell runs nothing and printf reads nothing.
taken '"%h"' '%h'
taken '"%h %d %s %% 100%"' '%h %d %s %% 100%'
# shellcheck disable=SC2016 # these are names, and nothing is meant to expand
taken '"$HOME $(id) `id` ${x} $1"' '$HOME $(id) `id` ${x} $1'
taken '"back\\slash \\n \\x41 \\u0041"' 'back\slash \n \x41 \u0041'
grep -qx '  <name replace-wildcards="no">back\\slash \\n \\x41 \\u0041</name>' "$ORIGAITV_ANNOUNCE_FILE" || fail "a backslash stays a backslash" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
pass "T28.5 a name with %h stays %h, with Avahi told to fill nothing in, and nothing in a name is run or expanded"

taken '"Dnevna soba"' 'Dnevna soba'
taken '"Küche"' 'Küche'
taken '"📺 Den"' '📺 Den'
taken '"Küche 📺"' 'Küche 📺'
taken '"K\u00fcche \ud83d\udcfa"' 'Küche 📺'
taken '"寝室"' '寝室'
taken '"סלון"' 'סלון'
taken '"👨‍👩‍👧‍👦 home"' '👨‍👩‍👧‍👦 home'
taken '"a  b"' 'a  b'
# 63 bytes is as long as a name on the network can be: 63 letters, or 21
# characters of 3 bytes each.
taken "\"$(printf 'a%.0s' $(seq 1 63))\"" "$(printf 'a%.0s' $(seq 1 63))"
taken "\"$(printf '€%.0s' $(seq 1 21))\"" "$(printf '€%.0s' $(seq 1 21))"
pass "T28.5 spaces, accents and emoji come out as typed, and so does a name of 63 bytes"

# The same name again changes nothing, and a new one is written.
touch -t 202601010000 "$ORIGAITV_ANNOUNCE_FILE"
before=$(ls -l "$ORIGAITV_ANNOUNCE_FILE")
hand "$(with_name "\"$(printf '€%.0s' $(seq 1 21))\"")"
announce || fail "the same name again is fine" "$(cat "$SCRATCH/out")"
[[ $(ls -l "$ORIGAITV_ANNOUNCE_FILE") == "$before" && ! -s $SCRATCH/out ]] || fail "the same name again leaves the file as it is" "$(cat "$SCRATCH/out")"
hand "$(with_name '"Bedroom"')"
announce || fail "a new name is taken" "$(cat "$SCRATCH/out")"
[[ $(cat "$ORIGAITV_ANNOUNCE_FILE") == "$(file_with "Bedroom")" ]] || fail "a new name is written over the old one" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
pass "the same name again leaves the file alone, and a new one is written"

# A name the helper doesn't take is left out: the TV is still announced, as
# OrigaiTV, and the helper says so without echoing what it was handed.
# left_out <what> <the drop>
left_out() {
  local what=$1 status=0
  printf '<service-group/>\n' >"$ORIGAITV_ANNOUNCE_FILE"
  hand "$2"
  announce || status=$?
  (( status == 0 )) || fail "T28.5 $what: the TV is still announced" "$(cat "$SCRATCH/out")"
  [[ $(cat "$ORIGAITV_ANNOUNCE_FILE") == "$(file_with OrigaiTV)" ]] || fail "T28.5 $what: the TV is announced as OrigaiTV, and nothing else in the file moves" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
  grep -qxF "$SAID_SO" "$SCRATCH/out" || fail "$what: it says the name was left out" "$(cat "$SCRATCH/out")"
  if grep -q "evil\|EVIL" "$SCRATCH/out"; then fail "$what isn't echoed" "$(cat "$SCRATCH/out")"; fi
  [[ ! -e $ORIGAITV_ANNOUNCE_DROP && -z $(ls -A "$SCRATCH/drop") ]] || fail "$what: the drop is gone" "$(ls -A "$SCRATCH/drop")"
  if type -P python3 >/dev/null; then
    [[ $(read_back) == "OrigaiTV" ]] || fail "$what: the file still reads as XML" "$(read_back 2>&1 || true)"
  fi
}
left_out "no name" "{\"on\":true,\"id\":\"$ID\",\"port\":3001}"
for json in '7' 'null' 'true' '["evil"]' '{"evil":"Living room"}'; do
  left_out "a name of $json, which isn't text" "$(with_name "$json")"
done
for json in '""' '" "' '"   "' '" evil"' '"evil "'; do
  left_out "the name $json, which is empty or has a space at an end" "$(with_name "$json")"
done
pass "T28.5 no name, one that isn't text, an empty one and one with a space at an end are left out, and the TV is announced as OrigaiTV"

left_out "a name with a newline" "$(with_name '"evil\nevil"')"
left_out "a name with a newline at its end" "$(with_name '"evil\n"')"
left_out "a name with a return" "$(with_name '"evil\revil"')"
left_out "a name with a tab" "$(with_name '"evil\tevil"')"
left_out "a name with a null" "$(with_name '"evil\u0000evil"')"
left_out "a name with an escape" "$(with_name '"\u001b[31mEVIL"')"
left_out "a name with a delete" "$(with_name '"evil\u007fevil"')"
left_out "a name with a next line, U+0085" "$(with_name '"evil\u0085evil"')"
left_out "a name with U+009F" "$(with_name '"evil\u009fevil"')"
left_out "two names, one after the other" "$(with_name '"evil"') {\"name\":\"EVIL\"}"
pass "T28.5 a name with a control character is left out: a newline, a return, a tab, a null, an escape, a delete, and those past U+007F"

left_out "a name of 64 bytes" "$(with_name "\"$(printf 'a%.0s' $(seq 1 64))\"")"
left_out "a name of 200 bytes" "$(with_name "\"$(printf 'x%.0s' $(seq 1 200))\"")"
left_out "a name of 22 characters that's 66 bytes" "$(with_name "\"$(printf '€%.0s' $(seq 1 22))\"")"
pass "T28.5 a name over 63 bytes is left out, by its bytes and not its characters"

# Bytes that aren't UTF-8: a byte that's never in it, a character written
# longer than it is, one cut short, half of a pair, and one past the end of
# Unicode. Then half of a pair as an escape.
left_out "a name with a byte that's never in UTF-8" "$(with_name $'"evil\xffevil"')"
left_out "a name with a character written too long" "$(with_name $'"evil\xc0\xafevil"')"
left_out "a name with a character cut short" "$(with_name $'"evil\xe2\x82"')"
left_out "a name with half of a pair" "$(with_name $'"evil\xed\xa0\x80evil"')"
left_out "a name past the end of Unicode" "$(with_name $'"evil\xf4\x90\x80\x80evil"')"
pass "T28.5 a name whose bytes aren't UTF-8 is left out"

# Half of a pair written as an escape. jq reads it as U+FFFD, and the name is
# left out, or it can't read the drop at all, and the drop is refused whole,
# as anything that isn't JSON is. Which one depends on the half and on jq's
# version. Either way the name isn't announced.
half() {
  local what=$1 status=0
  printf '<service-group/>\n' >"$ORIGAITV_ANNOUNCE_FILE"
  hand "$2"
  announce || status=$?
  if (( status == 0 )); then
    [[ $(cat "$ORIGAITV_ANNOUNCE_FILE") == "$(file_with OrigaiTV)" ]] || fail "T28.5 $what: the TV is announced as OrigaiTV" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
    grep -qxF "$SAID_SO" "$SCRATCH/out" || fail "$what: it says the name was left out" "$(cat "$SCRATCH/out")"
  else
    [[ $status == 1 && ! -e $ORIGAITV_ANNOUNCE_FILE ]] || fail "T28.5 $what: a drop jq can't read announces nothing" "$(cat "$SCRATCH/out")"
    grep -q "the drop isn't an id and a port, so the TV announces nothing" "$SCRATCH/out" || fail "$what: it says why" "$(cat "$SCRATCH/out")"
  fi
  if grep -q "evil\|EVIL" "$SCRATCH/out"; then fail "$what isn't echoed" "$(cat "$SCRATCH/out")"; fi
  [[ ! -e $ORIGAITV_ANNOUNCE_DROP && -z $(ls -A "$SCRATCH/drop") ]] || fail "$what: the drop is gone" "$(ls -A "$SCRATCH/drop")"
}
half "a name with the first half of a pair, escaped" "$(with_name '"evil\ud83devil"')"
half "a name that ends in the first half of a pair, escaped" "$(with_name '"evil\ud83d"')"
half "a name with the second half of a pair, escaped" "$(with_name '"evil\udcfaevil"')"
half "a name with a pair the wrong way round, escaped" "$(with_name '"evil\udcfa\ud83devil"')"
pass "T28.5 a name with half of a pair written as an escape is never announced"

# Code points Avahi refuses a name for, which would take the TV off the
# network if they reached the file, and the one jq writes for bad bytes.
left_out "a name with U+FFFD" "$(with_name '"evil\ufffdevil"')"
left_out "a name with U+FFFE" "$(with_name '"evil\ufffeevil"')"
left_out "a name with U+FFFF" "$(with_name '"evil\uffffevil"')"
left_out "a name with U+FDD0" "$(with_name '"evil\ufdd0evil"')"
left_out "a name with U+FDEF" "$(with_name '"evil\ufdefevil"')"
left_out "a name with U+1FFFE" "$(with_name '"evil\ud83f\udffeevil"')"
left_out "a name with U+10FFFF" "$(with_name '"evil\udbff\udfffevil"')"
pass "T28.5 a name with a code point Avahi refuses is left out, so the TV stays on the network"
hand '{"on":false}'
announce || fail "told to stop after the names, it stops" "$(cat "$SCRATCH/out")"

# Anything else is refused, and takes down what was published: a TV that
# says nothing is the safe way to be wrong. What was dropped isn't echoed.
refused() {
  local what=$1 status=0
  printf '<service-group/>\n' >"$ORIGAITV_ANNOUNCE_FILE"
  announce || status=$?
  (( status == 1 )) || fail "$what is refused" "$(cat "$SCRATCH/out")"
  [[ ! -e $ORIGAITV_ANNOUNCE_FILE ]] || fail "$what takes down what was published"
  [[ ! -e $ORIGAITV_ANNOUNCE_DROP && ! -L $ORIGAITV_ANNOUNCE_DROP && -z $(ls -A "$SCRATCH/drop") ]] || fail "$what: the drop is gone" "$(ls -A "$SCRATCH/drop")"
  if grep -q "evil\|EVIL" "$SCRATCH/out"; then fail "$what isn't echoed" "$(cat "$SCRATCH/out")"; fi
  grep -q "the drop isn't an id and a port, so the TV announces nothing" "$SCRATCH/out" || fail "$what: it says why" "$(cat "$SCRATCH/out")"
}
for drop in \
  'not json evil' \
  '[]' \
  '{}' \
  "{\"id\":\"$ID\",\"port\":3001}" \
  "{\"on\":\"true\",\"id\":\"$ID\",\"port\":3001}" \
  '{"on":true,"port":3001}' \
  '{"on":true,"id":"evil","port":3001}' \
  '{"on":true,"id":"0123456789ABCDEF0123456789ABCDEF","port":3001}' \
  '{"on":true,"id":"0123456789abcdef0123456789abcdef0","port":3001}' \
  '{"on":true,"id":"0123456789abcdef</txt-record>evil","port":3001}' \
  '{"on":true,"id":"0123456789abcdef0123456789abcdef\nevil","port":3001}' \
  '{"on":true,"id":["0123456789abcdef0123456789abcdef"],"port":3001}' \
  "{\"on\":true,\"id\":\"$ID\"}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":0}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":65536}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":-1}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":3001.5}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":\"3001\"}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":\"3001</port>evil\"}"; do
  hand "$drop"
  refused "a drop of $drop"
done
# A drop too long to be one: only its first kilobyte is read.
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001,\"pad\":\"$(printf 'x%.0s' $(seq 1 2000))\"}"
refused "a drop longer than a kilobyte"
# A link in the daemon's folder isn't followed, to a good drop or anywhere.
printf '{"on":true,"id":"%s","port":3001}' "$ID" >"$SCRATCH/elsewhere.json"
ln -s "$SCRATCH/elsewhere.json" "$ORIGAITV_ANNOUNCE_DROP"
refused "a link for a drop"
[[ -f $SCRATCH/elsewhere.json ]] || fail "and what it pointed at is left alone"
mkdir "$ORIGAITV_ANNOUNCE_DROP"
printf '{"on":true,"id":"%s","port":3001}' "$ID" >"$ORIGAITV_ANNOUNCE_DROP/announce.json"
refused "a folder for a drop"
pass "anything but an id of 32 hex digits and a port is refused, takes down what was published, and isn't echoed"

# No Avahi on the box: nowhere to say it.
status=0
hand "$GOOD"
ORIGAITV_ANNOUNCE_FILE="$SCRATCH/none/origaitv.service" announce || status=$?
(( status == 1 )) || fail "with no folder of Avahi's, it's refused" "$(cat "$SCRATCH/out")"
grep -q "isn't there, so the TV announces nothing" "$SCRATCH/out" || fail "and it says so" "$(cat "$SCRATCH/out")"
[[ ! -e $SCRATCH/none && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "and makes none, and still takes the drop"
pass "with no folder of Avahi's it writes nothing, and says so"

# The units, the firewall and the migration.
path="$ROOT/system/origaitv-announce.path"
unit="$ROOT/system/origaitv-announce.service"
grep -qx "PathExists=/var/lib/origaitv/daemon/announce-drop/announce.json" "$path" || fail "origaitv-announce.path watches the daemon's drop"
grep -qx "Unit=origaitv-announce.service" "$path" || fail "and starts origaitv-announce.service"
grep -qx "WantedBy=paths.target" "$path" || fail "and is enabled with the others"
grep -qx "ExecStart=/usr/bin/origaitv-announce-set" "$unit" || fail "origaitv-announce.service runs origaitv-announce-set"
if grep -q "^User=\|^DynamicUser=" "$unit"; then fail "as root"; fi
grep -qx "ProtectSystem=strict" "$unit" || fail "with the system read-only"
grep -qx "ReadWritePaths=-/var/lib/origaitv/daemon/announce-drop -/etc/avahi/services" "$unit" || fail "but for the drop and Avahi's folder"
for line in PrivateNetwork=yes NoNewPrivileges=yes CapabilityBoundingSet=CAP_DAC_OVERRIDE ProtectHome=yes PrivateTmp=yes PrivateDevices=yes; do
  grep -qx "$line" "$unit" || fail "origaitv-announce.service has $line"
done
pass "origaitv-announce.path hands the drop to origaitv-announce.service, as root, with two folders to write and no network"

# First boot's firewall leaf, with a stand-in ufw that writes down what it's
# asked.
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/ufw" <<STUB
#!/bin/bash
printf '%s\n' "\$*" >>"$SCRATCH/ufw-calls"
STUB
chmod 755 "$SCRATCH/bin/ufw"
PATH="$SCRATCH/bin:$PATH" bash -eE -c 'source "$1"' bash "$ROOT/install/tv/firewall.sh" >"$SCRATCH/out" 2>&1 || fail "install/tv/firewall.sh runs" "$(cat "$SCRATCH/out")"
mdns=$(grep " 5353 " "$SCRATCH/ufw-calls" || true)
expected=$(printf 'allow proto udp from %s to any port 5353 comment origaitv found on your network\n' 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16)
[[ $mdns == "$expected" ]] || fail "first boot opens mDNS, UDP 5353, to the home network's ranges and to nothing else" "$mdns"
migration=$(grep -l "origaitv-announce.path" "$ROOT"/migrations/origaitv/*.sh)
grep -qx "sudo systemctl start origaitv-announce.path || true" "$migration" || fail "boxes installed before start the hand-over"
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  grep -q "^for net in .*$net" "$migration" || fail "and get the firewall's line for $net"
done
# shellcheck disable=SC2016 # the $net is the migration's own
grep -qx '  sudo ufw allow proto udp from "$net" to any port 5353 comment "origaitv found on your network" || true' "$migration" || fail "the migration's line is first boot's"
pass "first boot opens mDNS to the home network only, and boxes installed before get the line and the hand-over from a migration"
