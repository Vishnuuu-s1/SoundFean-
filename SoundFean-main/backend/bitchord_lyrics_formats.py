"""BitChord lyric formats adapted for SoundFean. GPL-3.0, see BITCHORD-NOTICE.md.

All timings are milliseconds. Plain text remains untimed; never invent sync.
"""
from __future__ import annotations

import html
import json
import re
from xml.sax.saxutils import escape, quoteattr
from defusedxml import ElementTree as ET


def ms(value):
    if value is None or value == "":
        return None
    text = str(value).strip()
    try:
        if text.endswith("ms"):
            return round(float(text[:-2]))
        if text.endswith("s"):
            return round(float(text[:-1]) * 1000)
        parts = text.split(":")
        total = 0.0
        for part in parts:
            total = total * 60 + float(part)
        return round(total * 1000)
    except (ValueError, TypeError):
        return None


def line(time, text, words=None, end=None, **extra):
    return {"timeMs": max(0, int(time or 0)), "text": html.unescape(text).strip(),
            "words": words or [], "endMs": end, **extra}


def word(start, end, text):
    return {"startMs": max(0, int(start or 0)), "endMs": max(int(start or 0), int(end or start or 0)),
            "text": html.unescape(text)}


def parse_lrc(raw):
    raw = html.unescape(raw)
    offset = re.search(r"\[offset:([+-]?\d+)\]", raw, re.I)
    offset = int(offset[1]) if offset else 0
    rows = []
    for source in raw.splitlines():
        stamps = list(re.finditer(r"\[(\d+:\d+(?:\.\d+)?)\]", source))
        if not stamps:
            continue
        body = source[stamps[-1].end():].replace("<R>", "")
        markers = list(re.finditer(r"<(\d+:\d+(?:\.\d+)?)>", body))
        words = []
        for i, mark in enumerate(markers):
            stop = markers[i+1].start() if i+1 < len(markers) else len(body)
            text = body[mark.end():stop]
            if text.strip():
                start = (ms(mark[1]) or 0) + offset
                end = (ms(markers[i+1][1]) or 0) + offset if i+1 < len(markers) else start
                words.append(word(start, end, text))
        text = re.sub(r"<\d+:\d+(?:\.\d+)?>", "", body)
        for stamp in stamps:
            rows.append(line((ms(stamp[1]) or 0) + offset, text, words,
                             words[-1]['endMs'] if words else None,
                             agent="v2" if "<R>" in source else None))
    return sorted(rows, key=lambda r: r["timeMs"])


def parse_ttml(raw):
    try:
        root = ET.fromstring(raw)
    except Exception:
        return []

    def local(name):
        return name.rsplit("}", 1)[-1].split(":")[-1]

    def attr(node, name):
        return next((v for k, v in node.attrib.items() if local(k) == name), None)

    def collect(node, backing=False):
        pieces = []
        if node.text:
            pieces.append((node.text, None, None, backing))
        for child in node:
            role = attr(child, "role")
            if role not in {"x-translation", "x-roman"}:
                bg = backing or role == "x-bg"
                start, end = ms(attr(child, "begin")), ms(attr(child, "end"))
                timed_children = any(attr(n, "begin") for n in child.iter() if n is not child)
                if start is not None and end is not None and not timed_children:
                    pieces.append(("".join(child.itertext()), start, end, bg))
                else:
                    pieces.extend(collect(child, bg))
            if child.tail:
                pieces.append((child.tail, None, None, backing))
        return pieces

    rows = []
    for p in root.iter():
        if local(p.tag) != "p" or attr(p, "role") in {"x-translation", "x-roman"}:
            continue
        pieces = collect(p)
        lead, bg = [], []
        for text, start, end, backing in pieces:
            sink = bg if backing else lead
            if start is not None and text.strip():
                sink.append(word(start, end, text))
            elif sink and text.isspace() and not sink[-1]['text'].endswith(' '):
                sink[-1]['text'] += ' '
        text = ''.join(t for t, _, _, b in pieces if not b).strip()
        if not text:
            continue
        begin = ms(attr(p, "begin"))
        if begin is None:
            begin = lead[0]['startMs'] if lead else 0
        rows.append(line(begin, text, lead, ms(attr(p, "end")), background=bg, agent=attr(p, "agent")))
    return sorted(rows, key=lambda r: r['timeMs'])


def parse_karaoke(raw):
    content = re.search(r'LyricContent\s*=\s*"([^"]*)"', raw, re.I)
    if content:
        raw = html.unescape(content[1])
    rows = []
    for source in raw.splitlines():
        match = re.match(r'^\[(\d+),(\d+)\](.*)$', source.strip())
        if not match:
            continue
        start, duration, body = int(match[1]), int(match[2]), match[3]
        prefix = [word(int(m[1]), int(m[1])+int(m[2]), m[3])
                  for m in re.finditer(r'\((\d+),(\d+)(?:,\d+)?\)([^()]*)', body) if m[3].strip()]
        suffix = [word(int(m[2]), int(m[2])+int(m[3]), m[1])
                  for m in re.finditer(r'([^()]*)\((\d+),(\d+)(?:,\d+)?\)', body) if m[1].strip()]
        words = max([prefix, suffix], key=lambda ws: sum(len(w['text']) for w in ws))
        if words:
            text = re.sub(r'\(\d+,\d+(?:,\d+)?\)', '', body)
            rows.append(line(min(start, words[0]['startMs']), text, words, start+duration))
    return rows


def parse_plus(data):
    if not isinstance(data, dict) or not isinstance(data.get('lyrics'), list):
        return []
    rows = []
    for item in data['lyrics']:
        if not isinstance(item, dict) or item.get('time') is None:
            continue
        start = int(item['time'])
        words = [word(s['time'], s['time']+int(s.get('duration') or 0), s['text'])
                 for s in item.get('syllabus', []) if s.get('time') is not None and s.get('text')]
        text = ''.join(w['text'] for w in words) or item.get('text', '')
        element = item.get('element')
        agent = element.get('singer') if isinstance(element, dict) else (
            'v2' if isinstance(element, list) and any(v in element for v in ['right', 'opposite']) else None)
        if text.strip():
            rows.append(line(start, text, words, start+int(item.get('duration') or 0) or None, agent=agent))
    return rows


def parse_pax(data):
    if isinstance(data, dict):
        content = data.get('content')
        if isinstance(content, list) and any(isinstance(r, dict) and 'timestamp' in r for r in content):
            rows = []
            for i, row in enumerate(content):
                if not isinstance(row, dict) or not isinstance(row.get('text'), list):
                    continue
                start = int(row.get('timestamp') or 0)
                end = int(content[i+1].get('timestamp') or start) if i+1 < len(content) else None
                words = []
                for j, w in enumerate(row['text']):
                    if not isinstance(w, dict) or not w.get('text') or w.get('timestamp') is None:
                        continue
                    wstart = int(w['timestamp'])
                    wend = row['text'][j+1].get('timestamp') if j+1 < len(row['text']) else end
                    words.append(word(wstart, wend or wstart+800, w['text'].strip()+' '))
                text = ' '.join(w.get('text', '').strip() for w in row['text'] if isinstance(w, dict))
                if text:
                    rows.append(line(start, text, words, end))
            if rows:
                return rows
        for value in data.values():
            if isinstance(value, (dict, list)):
                result = parse_pax(value)
                if result:
                    return result
    elif isinstance(data, list):
        for value in data:
            result = parse_pax(value)
            if result:
                return result
    return []


def parse_richsync(raw):
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        rows = []
        for entry in data:
            start, end = round(entry['ts']*1000), round(entry['te']*1000)
            fragments = entry.get('l', [])
            words = [word(start+round(f['o']*1000),
                          start+round(fragments[i+1]['o']*1000) if i+1 < len(fragments) else end, f['c'])
                     for i, f in enumerate(fragments) if f.get('c')]
            rows.append(line(start, entry.get('x') or ''.join(w['text'] for w in words), words, end))
        return rows
    except (ValueError, TypeError, KeyError):
        return []


CONTENT_KEYS = ('ttml', 'ttmlContent', 'richSyncLyrics', 'syncedLyrics', 'lyrics', 'lrc',
                'content', 'text', 'plainLyrics', 'line', 'lines', 'lyric', 'data', 'result', 'response')


def parse_provider(raw, depth=0):
    if depth > 8 or raw is None:
        return []
    if isinstance(raw, dict):
        if raw.get('isError') or raw.get('ok') is False or raw.get('success') is False or raw.get('error'):
            return []
        rich = parse_plus(raw) or parse_pax(raw)
        if rich:
            return rich
        for key in CONTENT_KEYS:
            if key in raw:
                found = parse_provider(raw[key], depth+1)
                if found:
                    return found
        return []
    if isinstance(raw, list):
        # Arrays of documents are never concatenated into one song.
        for document in raw:
            found = parse_provider(document, depth+1)
            if found:
                return found
        return []
    if not isinstance(raw, str):
        return []
    text = raw.lstrip('\ufeff').strip()
    if text.startswith('```'):
        text = re.sub(r'^```[^\n]*\n|\n```$', '', text)
    try:
        value = json.loads(text)
        if value != raw:
            return parse_provider(value, depth+1)
    except (ValueError, TypeError):
        pass
    if '&lt;tt' in text:
        text = html.unescape(text)
    if re.search(r'<(?:\w+:)?tt(?:\s|>)', text, re.I):
        return parse_ttml(text)
    found = parse_karaoke(text) or parse_lrc(text)
    if found:
        return found
    if not text or text.startswith(('<', '{', '[')) and not re.match(r'\[(?:verse|chorus|intro|outro|bridge)', text, re.I):
        return []
    if re.search(r'\b(?:lyrics? (?:not found|unavailable)|error|access denied|rate limit)\b', text, re.I):
        return []
    return [line(0, s) for s in text.splitlines() if s.strip() and not re.match(r'^\[[A-Za-z]+:.*\]$', s)]


def result_payload(rows, provider, duration_ms=0):
    rows = sorted([r for r in rows if r.get('text') or r.get('timeMs', 0) > 0], key=lambda r: r['timeMs'])
    if not any(r['text'] for r in rows):
        return None
    synced = any(r['timeMs'] > 0 or any(w['endMs'] > 0 for w in r.get('words', [])) for r in rows)
    def stamp(value):
        n = max(0, int(value or 0))
        return f'{n//3600000:02d}:{n//60000%60:02d}:{n//1000%60:02d}.{n%1000:03d}'
    ttml = ['<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>']
    subtitles = []
    for i, row in enumerate(rows):
        start = row['timeMs'] if synced else 0
        next_time = rows[i+1]['timeMs'] if i+1 < len(rows) else (duration_ms or start+5000)
        word_end = max([w['endMs'] for w in row.get('words', [])] or [start])
        end = max(start, row.get('endMs') or word_end or next_time)
        if synced and end <= start:
            end = max(start, next_time)
        if not synced:
            end = 0
        agent = ' ttm:agent='+quoteattr(str(row['agent'])) if row.get('agent') else ''
        ttml.append(f'<p begin="{stamp(start)}" end="{stamp(end)}"{agent}>')
        if row.get('words'):
            for w in row['words']:
                ttml.append(f'<span begin="{stamp(w["startMs"])}" end="{stamp(w["endMs"])}">{escape(w["text"])}</span>')
        else:
            ttml.append(escape(row['text']))
        if row.get('background'):
            ttml.append('<span ttm:role="x-bg">')
            for w in row['background']:
                ttml.append(f'<span begin="{stamp(w["startMs"])}" end="{stamp(w["endMs"])}">{escape(w["text"])}</span>')
            ttml.append('</span>')
        ttml.append('</p>')
        subtitles.append(f'[{start//60000:02d}:{start//1000%60:02d}.{start%1000:03d}]{row["text"]}')
    ttml.append('</div></body></tt>')
    return {'ttml': ''.join(ttml), 'subtitles': '\n'.join(subtitles) if synced else None,
            'lyricsProvider': provider, 'synced': synced,
            'wordSynced': any(r.get('words') for r in rows), 'lineCount': len(rows)}
