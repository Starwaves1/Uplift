#!/bin/sh
set -e
cd "$(dirname "$0")/src"
{
  sed -n '1,/<!--SCRIPTS-->/p' shell.html | sed '$d'
  echo '<script>'
  cat gl.js audio.js world.js game.js draw.js ui.js
  echo '</script>'
} > ../gravity-loom.html
{
  printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  cat ../gravity-loom.html
  printf '\n</body></html>\n'
} > ../test.html
wc -c ../gravity-loom.html
