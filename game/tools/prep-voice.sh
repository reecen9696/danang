#!/usr/bin/env bash
# Prepares the enemy voice recordings for the web build.
#
# Each source file is one continuous take of a voice actor reading a run of
# separate lines. Rather than shipping thirty-odd tiny MP3s we keep the take
# whole — one fetch, one decode — and slice it at playback time from a table of
# offsets. This script produces both halves of that: the normalised MP3 in
# public/sfx, and src/audio/voiceLines.ts holding the offsets it detected.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/sfx"
mkdir -p "$OUT"

prep() { # prep <source> <output name>
  # Loudness-normalised so both actors sit at the same level as each other and
  # under the gunfire, mono because the game pans nothing, 96 kbps because
  # speech survives it and the take is long.
  ffmpeg -v error -y -i "$1" \
    -af "loudnorm=I=-18:TP=-2:LRA=11,highpass=f=90" \
    -codec:a libmp3lame -b:a 96k -ar 44100 -ac 1 "$OUT/$2.mp3"
  printf '%-10s %7s bytes  %s s\n' "$2" "$(stat -f%z "$OUT/$2.mp3")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$2.mp3" | cut -c1-5)"
}

prep "${1:-/Users/reece/Downloads/Dinh-Trung-Vietnamese (1).mp3}" voice-a
prep "${2:-/Users/reece/Downloads/Andy-Long-Vietnamese-.mp3}"     voice-b

# Cut the takes into lines and write the offset table.
python3 "$ROOT/tools/slice-voice.py" "$OUT/voice-a.mp3" "$OUT/voice-b.mp3" \
  > "$ROOT/src/audio/voiceLines.ts"
echo "wrote src/audio/voiceLines.ts"
