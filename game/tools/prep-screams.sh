#!/usr/bin/env bash
# Prepares the civilian screams for the web build.
#
# Two sources, each a long take with several screams in it, cut into two clips
# apiece so a field full of people running is not one clip on repeat (see the
# scream-woman / scream-child entries in src/audio/Audio.ts). Same treatment as
# the death cries: loudness-normalised, mono, 96 kbps, trimmed hard at the head
# so the scream lands on the frame the round goes past.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/sfx"
mkdir -p "$OUT"

WOMAN="${1:-/Users/reece/Downloads/Scary Woman Screaming - Sound Effect (HD).mp3}"
CHILD="${2:-/Users/reece/Downloads/loud kid screaming sound effect.mp3}"

clip() { # clip <source> <start> <duration> <output name>
  # The cuts land inside a continuous take, so both ends need a fade: 8 ms in
  # is short enough to keep the attack, and 180 ms out is long enough that a
  # scream stopping reads as a scream stopping and not as a dropped file.
  # The tail is trimmed and faded through a reverse rather than by timing the
  # fade off $3, because how much of the clip is actually the scream depends on
  # where the silence trim landed and not on where the cut was asked for.
  ffmpeg -v error -y -ss "$2" -t "$3" -i "$1" \
    -af "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,\
areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,areverse,\
loudnorm=I=-16:TP=-2:LRA=11,highpass=f=110,\
afade=t=in:st=0:d=0.008,areverse,afade=t=in:st=0:d=0.18,areverse" \
    -codec:a libmp3lame -b:a 96k -ar 44100 -ac 1 "$OUT/$4.mp3"
  printf '%-16s %7s bytes  %s s\n' "$4" "$(stat -f%z "$OUT/$4.mp3")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$4.mp3" | cut -c1-5)"
}

# The woman's take is three separate screams with silence between them: the
# first one has the hardest attack, and the last is the shorter, more ragged
# one further into it.
clip "$WOMAN" 0.45  1.40 scream-woman-a
clip "$WOMAN" 20.10 1.85 scream-woman-b

# The child's take is one unbroken seven seconds. The first cut takes the yell
# it opens with; the second comes off the loudest stretch in the middle, which
# is a different shape of the same voice.
clip "$CHILD" 0.25 1.20 scream-child-a
clip "$CHILD" 3.55 1.50 scream-child-b
