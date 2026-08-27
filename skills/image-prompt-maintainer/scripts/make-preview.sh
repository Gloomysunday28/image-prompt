#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <source-image> <output-jpeg>\n' "$0" >&2
  exit 2
fi

source_image=$1
output_image=$2

if [[ ! -f "$source_image" ]]; then
  printf 'Source image not found: %s\n' "$source_image" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output_image")"

if command -v sips >/dev/null 2>&1; then
  sips -s format jpeg -z 383 680 "$source_image" --out "$output_image" >/dev/null
  preview_width=$(sips -g pixelWidth "$output_image" | awk '/pixelWidth/ {print $2}')
  preview_height=$(sips -g pixelHeight "$output_image" | awk '/pixelHeight/ {print $2}')
elif command -v magick >/dev/null 2>&1; then
  magick "$source_image" -resize '680x383^' -gravity center -extent 680x383 -quality 90 "$output_image"
  preview_width=$(magick identify -format '%w' "$output_image")
  preview_height=$(magick identify -format '%h' "$output_image")
else
  printf 'Neither sips nor ImageMagick is available to create the preview.\n' >&2
  exit 1
fi

if [[ "$preview_width" != 680 || "$preview_height" != 383 ]]; then
  printf 'Unexpected preview dimensions: %sx%s\n' "$preview_width" "$preview_height" >&2
  exit 1
fi

printf 'Created %s (%sx%s)\n' "$output_image" "$preview_width" "$preview_height"
