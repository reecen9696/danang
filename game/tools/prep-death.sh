#!/usr/bin/env bash
# Prepares the enemy death cries for the web build.
#
# Two takes, played at random when a bot dies (see src/audio/Audio.ts). Same
# treatment as the chatter takes so a death sits at the same level as a shout:
# loudness-normalised, mono, 96 kbps. The silence trim matters more here than
# it does for the takes — the cry has to land on the frame the man drops.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/sfx"
mkdir -p "$OUT"

prep() { # prep <source> <output name>
  # silenceremove twice with a reverse between: once for the head, once for
  # the tail. Death cries trail off, so the tail threshold is the lower one.
  ffmpeg -v error -y -i "$1" \
    -af "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,\
areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-55dB:detection=peak,areverse,\
loudnorm=I=-18:TP=-2:LRA=11,highpass=f=90,afade=t=in:st=0:d=0.005" \
    -codec:a libmp3lame -b:a 96k -ar 44100 -ac 1 "$OUT/$2.mp3"
  printf '%-12s %7s bytes  %s s\n' "$2" "$(stat -f%z "$OUT/$2.mp3")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$2.mp3" | cut -c1-5)"
}

prep "${1:-/Users/reece/Downloads/vinodadora-male-death-sound-128357.mp3}"  death-cry-a
prep "${2:-/Users/reece/Downloads/u_ckpn52p1rm-dying-sound-363801.mp3}"     death-cry-b
