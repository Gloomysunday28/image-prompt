#!/usr/bin/env python3
"""Synthesize with the approved voice; keep raw audio and timing provenance."""
import argparse
import asyncio
import hashlib
import importlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import wave

SKILL = Path(__file__).resolve().parents[1]
PROFILE = SKILL / 'assets/voice-profile.json'
LOCAL_FF = Path('/Users/caijiadi/image-prompt/tools/sadtalker-bin/ffmpeg')
LOCAL_EDGE = Path('/Users/caijiadi/image-prompt/outputs/tang-taizong-20260918/work/edge_tts_pkg')


def edge_module():
    try:
        return importlib.import_module('edge_tts')
    except ModuleNotFoundError:
        if LOCAL_EDGE.is_dir():
            sys.path.insert(0, str(LOCAL_EDGE))
        return importlib.import_module('edge_tts')


def run(ff, args):
    subprocess.run([str(ff), '-y', '-hide_banner', '-loglevel', 'error', *map(str, args)], check=True)


async def generate(text, profile, raw):
    edge = edge_module()
    events = []
    tts = edge.Communicate(text, voice=profile['voice'], rate=profile['rate'],
                           pitch=profile['pitch'], volume=profile['volume'], boundary='WordBoundary')
    with raw.open('wb') as stream:
        async for chunk in tts.stream():
            if chunk['type'] == 'audio':
                stream.write(chunk['data'])
            elif chunk['type'] == 'WordBoundary':
                events.append(chunk)
    return events


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--text-file', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--ffmpeg', type=Path)
    parser.add_argument('--raw-mp3', type=Path, help='Reprocess existing audio already synthesized with this voice')
    parser.add_argument('--events-json', type=Path, help='Original Edge WordBoundary events for --raw-mp3')
    args = parser.parse_args()
    profile = json.loads(PROFILE.read_text())
    for name, expected in profile['asset_sha256'].items():
        actual = hashlib.sha256((SKILL / 'assets' / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError('Approved asset changed: ' + name)
    ff = args.ffmpeg or (LOCAL_FF if LOCAL_FF.exists() else shutil.which('ffmpeg'))
    if not ff:
        raise FileNotFoundError('FFmpeg unavailable; pass --ffmpeg without changing the voice')
    subprocess.run([str(ff), '-version'], check=True, stdout=subprocess.DEVNULL)
    if args.check:
        module = edge_module()
        print(json.dumps({'voice': profile['voice'], 'rate': profile['rate'], 'pitch': profile['pitch'],
                          'assets_verified': True, 'ffmpeg': str(ff), 'edge_tts': module.__file__}, ensure_ascii=False))
        return
    if not args.text_file or not args.output:
        parser.error('--text-file and --output are required')
    if args.output.suffix.lower() != '.wav':
        parser.error('--output must end in .wav')
    if args.events_json and not args.raw_mp3:
        parser.error('--events-json requires --raw-mp3')
    text = args.text_file.read_text(encoding='utf-8').strip()
    if not text:
        raise ValueError('Narration is empty')
    out = args.output.resolve()
    raw = out.with_name(out.stem + '-raw.mp3')
    events_path = out.with_name(out.stem + '-events.json')
    meta = out.with_suffix('.json')
    if any(p.exists() for p in [out, raw, events_path, meta]):
        raise FileExistsError('Output files exist; choose another output name to preserve prior work')
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.raw_mp3:
        shutil.copy2(args.raw_mp3, raw)
        events = json.loads(args.events_json.read_text()) if args.events_json else []
    else:
        events = asyncio.run(generate(text, profile, raw))
    events_path.write_text(json.dumps(events, ensure_ascii=False, indent=2))
    sr = profile['sample_rate']
    with tempfile.TemporaryDirectory(prefix='approved-voice-') as temp:
        decoded = Path(temp) / 'decoded.wav'
        run(ff, ['-i', raw, '-ac', '1', '-ar', sr, '-c:a', 'pcm_s16le', decoded])
        with wave.open(str(decoded)) as wav:
            data = wav.readframes(wav.getnframes())
        samples = struct.unpack('<' + 'h' * (len(data) // 2), data)
        win = round(sr * .02)
        active = [i for i in range(0, len(samples), win)
                  if math.sqrt(sum(x*x for x in samples[i:i+win]) / len(samples[i:i+win])) > 90]
        if not active:
            raise ValueError('No audible speech; output not produced')
        start = max(0, active[0] / sr - .1)
        end = min(len(samples) / sr, (active[-1] + win) / sr + .16)
        # Word boundaries conservatively protect soft speech from threshold trimming.
        if events:
            start = min(start, max(0, min(e['offset'] for e in events) / 1e7 - .1))
            word_end = max((e['offset'] + e['duration']) / 1e7 for e in events)
            end = min(len(samples) / sr, max(end, word_end + .16))
        fade = profile['fade_out_seconds']
        filters = (f'atrim=start={start}:end={end},asetpts=PTS-STARTPTS,'
                   f"highpass=f={profile['highpass_hz']},"
                   f"loudnorm=I={profile['loudness_lufs']}:TP={profile['true_peak_db']}:LRA={profile['loudness_range']},"
                   f'afade=t=out:st={max(0, end-start-fade)}:d={fade}')
        run(ff, ['-i', raw, '-af', filters, '-ar', sr, '-ac', '1', '-c:a', 'pcm_s16le', out])
    with wave.open(str(out)) as wav:
        duration = wav.getnframes() / wav.getframerate()
    boundaries = []
    for event in events:
        begin = max(0, min(duration, event['offset'] / 1e7 - start))
        finish = max(begin, min(duration, (event['offset'] + event['duration']) / 1e7 - start))
        boundaries.append({'text': event['text'], 'start': begin, 'end': finish})
    report = {'voice_profile': profile, 'text': text, 'audio': str(out), 'duration': duration,
              'raw_audio': str(raw), 'raw_events': str(events_path), 'trim_start': start,
              'word_boundaries': boundaries, 'source': 'existing_audio' if args.raw_mp3 else 'edge-tts',
              'reference_sha256': profile['asset_sha256']['approved-voice.wav']}
    meta.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'audio': str(out), 'duration': duration, 'metadata': str(meta)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
