#!/usr/bin/env bash
# Prepares the jungle ambience bed for the web build.
#
# The source is ten minutes at 256 kbps, which is neither shippable nor
# necessary: a bird bed is texturally uniform, so a minute of it loops without
# anyone noticing. What matters is that the seam is inaudible, and that takes
# more than cutting sixty seconds out of the middle.
#
# The trick is to build the loop so its end already flows into its start. Take
# A = source[T0, T0+LOOP] and B = the XFADE seconds that follow A in the source.
# The output is A with its first XFADE seconds replaced by B crossfading into
# them. Playing that on repeat, the untouched tail of A runs into B — which is
# exactly what came after it in the recording — so the join is a crossfade the
# ear reads as more jungle rather than as a cut.
#
# Encoded stereo, unlike the mono voice takes: this is the only wide thing in
# the mix and collapsing it would put the whole jungle in the centre of the
# player's head.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/sfx"
SRC="${1:-/Users/reece/Downloads/placidplace-nature-soundstropicaljunglebirds-108380.mp3}"
mkdir -p "$OUT"

# Seconds into the source to start, loop length, and crossfade length.
T0=8
LOOP=60
XFADE=4

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A: the loop body. B: what follows it, which becomes the new head.
ffmpeg -v error -y -ss "$T0" -t "$LOOP" -i "$SRC" -ar 44100 -ac 2 "$TMP/a.wav"
ffmpeg -v error -y -ss "$((T0 + LOOP))" -t "$XFADE" -i "$SRC" -ar 44100 -ac 2 "$TMP/b.wav"
ffmpeg -v error -y -t "$XFADE" -i "$TMP/a.wav" "$TMP/a-head.wav"
ffmpeg -v error -y -ss "$XFADE" -i "$TMP/a.wav" "$TMP/a-rest.wav"

# acrossfade's output is d1 + d2 - XFADE, i.e. XFADE seconds. Concatenating the
# untouched remainder therefore gives back exactly LOOP seconds.
ffmpeg -v error -y -i "$TMP/b.wav" -i "$TMP/a-head.wav" \
  -filter_complex "acrossfade=d=$XFADE:c1=tri:c2=tri" "$TMP/head.wav"
ffmpeg -v error -y -i "$TMP/head.wav" -i "$TMP/a-rest.wav" \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" "$TMP/loop.wav"

# Loudness well below the gunfire: this sits under everything, always running.
# highpass clears the rumble a field recording always has and that a game mix
# has no room for.
ffmpeg -v error -y -i "$TMP/loop.wav" \
  -af "highpass=f=110,loudnorm=I=-26:TP=-3:LRA=9" \
  -codec:a libmp3lame -b:a 96k -ar 44100 -ac 2 "$OUT/ambience-jungle.mp3"

printf '%-18s %8s bytes  %s s\n' ambience-jungle \
  "$(stat -f%z "$OUT/ambience-jungle.mp3")" \
  "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/ambience-jungle.mp3" | cut -c1-5)"
