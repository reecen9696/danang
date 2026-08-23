#!/usr/bin/env bash
# Prepares the wave-start bugle for the web build.
#
# This one is not a world sound: it is played at distance 0 with no air filter
# in front of it (see Audio.playSample), so it wants to be dry, punchy and
# level with itself every time. The source is a stereo library recording with a
# third of a second of silence in front and a long dead tail behind — both go,
# so the call lands on the frame the wave is announced, and the file is mono
# because nothing else in sfx/ is placed in the stereo field either.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/sfx"
SRC="${1:-/Users/reece/Downloads/Trumpet Sound  Sound FX.mp3}"
mkdir -p "$OUT"

# Loud, but under the gunfire's ceiling: this plays over a wave announcement,
# not over silence. The 8 ms fade-in kills the click the silence trim leaves.
ffmpeg -v error -y -i "$SRC" \
  -af "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,areverse,afade=t=in:st=0:d=0.008,loudnorm=I=-14:TP=-1.5:LRA=7" \
  -codec:a libmp3lame -b:a 96k -ar 44100 -ac 1 "$OUT/wave-horn.mp3"

printf '%-14s %8s bytes  %s s\n' wave-horn "$(stat -f%z "$OUT/wave-horn.mp3")" \
  "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/wave-horn.mp3" | cut -c1-5)"
