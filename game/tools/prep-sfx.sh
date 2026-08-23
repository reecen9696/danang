#!/usr/bin/env bash
# Prepares Snake's Authentic Gun Sounds 2 for the web build:
# strips leading silence (so a shot fires the instant you click), applies a
# 3 ms fade-in to kill the resulting click, and re-encodes to 160 kbps MP3.
set -euo pipefail

SRC="/Users/reece/Downloads/Snake's Authentic Gun Sounds 2"
OUT="/Users/reece/code/personal/aceofspades/game/public/sfx"
mkdir -p "$OUT"

prep() { # prep <relative source> <output name>
  local src="$SRC/$1" dst="$OUT/$2.mp3"
  ffmpeg -v error -y -i "$src" \
    -af "silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,afade=t=in:st=0:d=0.003" \
    -codec:a libmp3lame -b:a 160k -ar 44100 "$dst"
  printf '%-22s %7s bytes  %s s\n' "$2" "$(stat -f%z "$dst")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$dst" | cut -c1-5)"
}

# --- gunshots (Full Sound: includes the natural outdoor tail) --------------
prep "Full Sound/.22LR/MP3/22LR Single MP3.mp3"        shot-22lr
prep "Full Sound/5.56/MP3/556 Single MP3.mp3"          shot-556
prep "Full Sound/7.62x39/MP3/762x39 Single MP3.mp3"    shot-762x39
prep "Full Sound/7.62x54R/MP3/762x54r Single MP3.mp3"  shot-762x54r

# --- reloads, split into mag-out / mag-in halves so each half can be timed
# --- against the weapon's own reload window ------------------------------
prep "Reloads, Cycling & More/MP3/Angel Mag Reload Part 1 MP3.mp3"   reload-pistol-out
prep "Reloads, Cycling & More/MP3/Angel Mag Reload Part 2 MP3.mp3"   reload-pistol-in
prep "Reloads, Cycling & More/MP3/AR Reload Part 1 MP3.mp3"         reload-ar-out
prep "Reloads, Cycling & More/MP3/AR Reload Part 2 MP3.mp3"         reload-ar-in
prep "Reloads, Cycling & More/MP3/308 Magazine Part 1 MP3.mp3"      reload-rifle-out
prep "Reloads, Cycling & More/MP3/308 Magazine Part 2 MP3.mp3"      reload-rifle-in
prep "Reloads, Cycling & More/MP3/AK Reload Part 1 MP3.mp3"         reload-ak-out
prep "Reloads, Cycling & More/MP3/AK Reload Part 2 MP3.mp3"         reload-ak-in
prep "Reloads, Cycling & More/MP3/Pump Shell Load MP3.mp3"          shell-load

# --- cycling / handling ----------------------------------------------------
prep "Reloads, Cycling & More/MP3/Mosin Bolt Cycle MP3.mp3"       cycle-bolt
prep "Reloads, Cycling & More/MP3/Lever Cycle Fast MP3.mp3"       cycle-pump
prep "Reloads, Cycling & More/MP3/AR Bolt Release MP3.mp3"        bolt-release
prep "Reloads, Cycling & More/MP3/AR Charging Handle MP3.mp3"     charging-handle
