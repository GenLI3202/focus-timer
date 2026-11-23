#!/bin/sh
# Rebuild docs/images/card.png from docs/card-mock.html (a design mock of the card, not the live mod).
# Animations are frozen at a chosen moment: a negative delay, paused. Needs Google Chrome and ffmpeg.
set -e
cd "$(dirname "$0")"
mkdir -p images _build
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
freeze() { # delay-seconds out
  sed "s|<body|<style>*{animation-delay:-$1s!important;animation-play-state:paused!important}</style><body|" card-mock.html > "_build/$2.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$PWD/_build/prof" \
    --force-device-scale-factor=2 --window-size=700,820 --screenshot="$PWD/_build/$2.png" "file://$PWD/_build/$2.html" >/dev/null 2>&1
}
freeze 1.5 peek
freeze 1.6 yay
# Two rows: the crab peeking in mid-round (blink), and cheering at the finish (yay).
ffmpeg -loglevel error -y -i _build/peek.png -vf "crop=1240:124:40:303" _build/a.png
ffmpeg -loglevel error -y -i _build/yay.png -vf "crop=1240:118:40:918" _build/b.png
ffmpeg -loglevel error -y -i _build/a.png -i _build/b.png -filter_complex vstack images/card.png
rm -rf _build
