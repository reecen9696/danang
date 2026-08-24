#!/usr/bin/env bash
# Prepares the boombox tracks for the web build.
#
# Everything that comes out of that speaker goes through a band-limiting radio
# chain at runtime (see src/audio/Radio.ts), so shipping a full-fidelity stereo
# master would be paying to download frequencies the effect throws away. Mono at
# 32 kHz keeps every band the chain actually passes and costs a third as much.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/music"
mkdir -p "$OUT"

prep() { # prep <source> <output name>
  ffmpeg -v error -y -i "$1" \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
    -codec:a libmp3lame -b:a 72k -ar 32000 -ac 1 "$OUT/$2.mp3"
  printf '%-16s %8s bytes  %s s\n' "$2" "$(stat -f%z "$OUT/$2.mp3")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$2.mp3" | cut -c1-5)"
}

prep "${1:-/Users/reece/Downloads/Creedence Clearwater Revival - Fortunate Son.mp3}" fortunate-son
prep "${2:-/Users/reece/Downloads/Creedence Clearwater Revival - I Heard It Through The Grapevine (Official Music Video).mp3}" grapevine

# The village song is not on the boombox: it is heard over the market square as
# itself, so none of the reasoning above applies to it. Nothing band-limits it
# at runtime, and a folk take is mostly voice and plucked strings -- both of
# which live in the top end the radio chain would have thrown away -- so it
# keeps a full 44.1 kHz band. Still mono: it is one source standing in one
# village, and stereo would double the download to widen something the player
# only ever hears from outside.
prep_town() { # prep_town <source> <output name>
  ffmpeg -v error -y -i "$1" \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
    -codec:a libmp3lame -b:a 80k -ar 44100 -ac 1 "$OUT/$2.mp3"
  printf '%-16s %8s bytes  %s s\n' "$2" "$(stat -f%z "$OUT/$2.mp3")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$2.mp3" | cut -c1-5)"
}

prep_town "${3:-/Users/reece/Downloads/Hoa Thơm Bướm Lượn - Vietnamese folk song.mp3}" village-folk
