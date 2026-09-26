"""BitChord's 16-source lyrics lookup, adapted to SoundFean's Flask service.

GPL-3.0; see BITCHORD-NOTICE.md. This module never resolves or plays audio.
Provider misses, authentication errors and timeouts fall through to the next
source. PaxSenix's two authenticated routes require PAXSENIX_API_KEY.
"""
from __future__ import annotations

import base64
import concurrent.futures as futures
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import socket
import threading
import time
from urllib.parse import urlencode, urljoin, urlsplit
import uuid

import requests
from bs4 import BeautifulSoup
from flask import Blueprint, jsonify, request

try:
    from .bitchord_lyrics_formats import line, parse_provider, parse_richsync, result_payload
except ImportError:
    from bitchord_lyrics_formats import line, parse_provider, parse_richsync, result_payload

lyrics_blueprint = Blueprint('bitchord_lyrics', __name__)
SOURCES = (
    ('BINI_LYRICS', 'BiniLyrics'), ('BETTER_LYRICS', 'BetterLyrics'),
    ('BETTER_LYRICS_PORTATO', 'BetterLyrics Portato'), ('PAXSENIX', 'PaxSenix'),
    ('PAXSENIX_SPOTIFY', 'PaxSenix: Spotify'), ('PAXSENIX_MUSIXMATCH', 'PaxSenix: Musixmatch'),
    ('LYRICS_PLUS', 'LyricsPlus'), ('SIMP_MUSIC', 'SimpMusic'), ('UNISON', 'Unison'),
    ('YOUTUBE_TRANSCRIPT', 'YouTube captions'), ('YOUTUBE_MUSIC', 'YouTube Music'),
    ('MEGALOBIZ', 'Megalobiz'), ('KUGOU', 'KuGou'), ('LRCLIB', 'LRCLIB'),
    ('MUSIXMATCH', 'Musixmatch'), ('GENIUS', 'Genius'),
)
MIRRORS = ('https://lyricsplus.prjktla.my.id', 'https://lyricsplus.atomix.one',
           'https://lyricsplus.binimum.org', 'https://lyricsplus.prjktla.workers.dev',
           'https://lyricsplus-seven.vercel.app', 'https://lyrics-plus-backend.vercel.app')
POOL = futures.ThreadPoolExecutor(max_workers=24, thread_name_prefix='lyrics')
MIRROR_POOL = futures.ThreadPoolExecutor(max_workers=6, thread_name_prefix='lyrics-mirror')
LOOKUPS = threading.BoundedSemaphore(2)
LOCK = threading.Lock()
CACHE = {}
INFLIGHT = {}
LAST_MIRROR = None
APPLE_TOKEN = None
MXM_SECRET = None
MXM_TOKEN = None
GUID = str(uuid.uuid4())
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
USER_AGENT = 'SoundFean (BitChord lyrics adaptation)'


@dataclass(frozen=True)
class Query:
    title: str
    artist: str
    album: str = ''
    duration: int = 0
    video_id: str = ''
    isrc: str = ''
    apple_id: str = ''
    deadline: float = 0

    def params(self):
        return {k: v for k, v in {'title': self.title, 'artist': self.artist, 'album': self.album,
                                 'duration': self.duration, 'isrc': self.isrc}.items() if v}


def clean_title(raw):
    value = re.sub(r'\((?:from|official|lyrics?|lyrical|audio|video|visuali[sz]er|full song|hd|4k)[^)]*\)|\[[^]]*\]',
                   ' ', raw, flags=re.I).split(' | ')[0]
    return re.sub(r'\s+', ' ', value).strip() or raw


def public_url(url):
    """Remote document URLs may never target internal services or local files."""
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        return False
    try:
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        return bool(addresses) and all(ipaddress.ip_address(a[4][0]).is_global for a in addresses)
    except (OSError, ValueError):
        return False


def get(q, url, params=None, headers=None, payload=None):
    if params:
        url += ('&' if '?' in url else '?') + urlencode({k: v for k, v in params.items() if v is not None})
    for _ in range(4):
        remaining = q.deadline - time.monotonic()
        if remaining <= 0 or not public_url(url):
            return None
        try:
            response = requests.request('POST' if payload is not None else 'GET', url,
                json=payload, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*', **(headers or {})},
                timeout=(min(3, remaining), min(6, remaining)), allow_redirects=False, stream=True)
            with response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get('Location', ''))
                    continue
                if not response.ok:
                    return None
                content = bytearray()
                for chunk in response.iter_content(16384):
                    content.extend(chunk)
                    if len(content) > 3_000_000 or time.monotonic() >= q.deadline:
                        return None
                return content.decode('utf-8-sig', errors='replace')
        except requests.RequestException:
            return None
    return None


def data(q, url, params=None, headers=None, payload=None):
    raw = get(q, url, params, headers, payload)
    try:
        return json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        return {}


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def named(value, key):
    return [obj[key] for obj in objects(value) if isinstance(obj.get(key), dict)]


def yt_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if 'text' in value or 'simpleText' in value:
            return value.get('text', value.get('simpleText', ''))
        return ''.join(yt_text(v) for v in value.values())
    if isinstance(value, list):
        return ''.join(yt_text(v) for v in value)
    return ''


def artist_name(item):
    value = item.get('artistName') or item.get('artist_name') or item.get('artist_names') or item.get('artists') or item.get('artist') or ''
    if isinstance(value, list):
        return ', '.join(str(v.get('name', '')) if isinstance(v, dict) else str(v) for v in value)
    if isinstance(value, dict):
        return value.get('name', '')
    return str(value)


def score(item, q):
    attrs = item.get('attributes') or item
    title = next((str(attrs[k]) for k in ['title', 'name', 'trackName', 'track_name'] if attrs.get(k)), '')
    artist = artist_name(attrs)
    duration = next((attrs[k] for k in ['durationInMillis', 'durationMs', 'duration_ms', 'duration', 'track_length'] if attrs.get(k)), 0)
    try:
        duration = float(duration)
        if duration > 10000:
            duration /= 1000
    except (ValueError, TypeError):
        duration = 0
    def match(a, b):
        a, b = a.casefold().strip(), b.casefold().strip()
        return 2 if a and a == b else 1 if a and b and (a in b or b in a) else 0
    return match(title, q.title)*20 + match(artist, q.artist)*15 + (
        max(0, 10-abs(duration-q.duration)) if q.duration and duration else 0)


def best_item(root, q):
    candidates = [obj for obj in objects(root) if any(obj.get(k) for k in ['id', 'trackId', 'track_id', 'realId'])
                  and any((obj.get('attributes') or obj).get(k) for k in ['title', 'name', 'trackName', 'track_name'])]
    best = max(candidates, key=lambda c: score(c, q), default=None)
    return best if best and score(best, q) >= 20 else None


def identify(q):
    params = {'isrc': q.isrc} if q.isrc else {'track': q.title, 'artist': q.artist, 'album': q.album or None, 'duration': q.duration or None}
    root = data(q, 'https://lyrics-api.binimum.org/', params)
    return next(iter(root.get('results') or []), None) if isinstance(root, dict) else None


def bini(q, hit=None):
    hit = hit or identify(q)
    return parse_provider(get(q, hit['lyricsUrl'])) if hit and hit.get('lyricsUrl') else []


def better(q, portato=False):
    endpoint = 'https://lyrics-api.boidu.dev/' + ('qq/' if portato else '') + 'getLyrics'
    return parse_provider(get(q, endpoint, {'s': q.title, 'a': q.artist, 'd': q.duration or None, 'al': q.album or None}))


def unison(q):
    root = data(q, 'https://unison.boidu.dev/lyrics', {'song': q.title, 'artist': q.artist, 'album': q.album or None, 'duration': q.duration or None})
    return parse_provider(root.get('data')) if root.get('success') is True else []


def lyrics_plus(q):
    global LAST_MIRROR
    hosts = ([LAST_MIRROR] if LAST_MIRROR else []) + [h for h in MIRRORS if h != LAST_MIRROR]
    jobs = {MIRROR_POOL.submit(lambda host: parse_provider(data(q, host+'/v2/lyrics/get', q.params())), host): host for host in hosts}
    try:
        for job in futures.as_completed(jobs, timeout=max(.01, q.deadline-time.monotonic())):
            try:
                rows = job.result()
            except Exception:
                continue
            if rows:
                LAST_MIRROR = jobs[job]
                return rows
    except futures.TimeoutError:
        pass
    finally:
        for job in jobs:
            job.cancel()
    return []


def simpmusic(q):
    if not VIDEO_ID.fullmatch(q.video_id):
        return []
    root = data(q, 'https://api-lyrics.simpmusic.org/v1/'+q.video_id)
    if root.get('success') is not True:
        return []
    tracks = [t for t in root.get('data', []) if not q.duration or abs((t.get('duration') or 0)-q.duration) <= 10]
    track = min(tracks, key=lambda t: abs((t.get('duration') or 0)-q.duration), default={})
    return parse_provider(track.get('richSyncLyrics')) or parse_provider(track.get('syncedLyrics'))


def lrclib(q):
    params = {'track_name': q.title, 'artist_name': q.artist, 'duration': q.duration}
    root = data(q, 'https://lrclib.net/api/get', params)
    rows = parse_provider(root.get('syncedLyrics')) if isinstance(root, dict) else []
    if rows:
        return rows
    hits = data(q, 'https://lrclib.net/api/search', {'track_name': q.title, 'artist_name': q.artist})
    if not isinstance(hits, list):
        return []
    hits = [h for h in hits if h.get('syncedLyrics') and (not q.duration or abs((h.get('duration') or 0)-q.duration) <= 10)]
    hit = min(hits, key=lambda h: abs((h.get('duration') or 0)-q.duration), default={})
    return parse_provider(hit.get('syncedLyrics'))


def pax_key():
    return re.sub(r'^Bearer\s+', '', os.environ.get('PAXSENIX_API_KEY', '').strip(), flags=re.I)


def apple_id(q):
    global APPLE_TOKEN
    if q.apple_id.isdigit():
        return q.apple_id
    if not APPLE_TOKEN:
        page = get(q, 'https://music.apple.com/us/new') or ''
        script = re.search(r'/assets/index~[^"\s]+\.js', page)
        if not script:
            return None
        js = get(q, 'https://music.apple.com'+script[0]) or ''
        token = re.search(r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', js)
        APPLE_TOKEN = token[0] if token else None
    if not APPLE_TOKEN:
        return None
    root = data(q, 'https://amp-api.music.apple.com/v1/catalog/us/search',
                {'term': q.title+' '+q.artist, 'types': 'songs', 'limit': 10, 'l': 'en-US'},
                {'Authorization': 'Bearer '+APPLE_TOKEN, 'Origin': 'https://music.apple.com', 'Referer': 'https://music.apple.com/'})
    best = best_item(root, q)
    return best.get('id') if best else None


def pax(q, mode='apple'):
    if mode == 'apple':
        identity = apple_id(q)
        return parse_provider(data(q, 'https://lyrics.paxsenix.org/apple-music/lyrics', {'id': identity, 'ttml': 'true'})) if identity else []
    key = pax_key()
    if not key:
        return []
    headers = {'Authorization': 'Bearer '+key}
    rows = []
    if mode == 'spotify':
        root = data(q, 'https://api.paxsenix.org/spotify/search', {'q': q.title+' '+q.artist}, headers)
        best = best_item(root, q)
        identity = next((best[k] for k in ['id', 'trackId', 'track_id', 'realId'] if best.get(k)), None) if best else None
        if identity:
            rows = parse_provider(data(q, 'https://api.paxsenix.org/lyrics/spotify', {'id': identity}, headers))
    else:
        rows = parse_provider(data(q, 'https://api.paxsenix.org/lyrics/musixmatch', {'t': q.title, 'a': q.artist, 'd': q.duration}, headers))
    if rows:
        return rows
    root = data(q, 'https://api.paxsenix.org/lyrics/lrcget', {'q': q.title+' '+q.artist}, headers)
    docs = root.get('lyrics') if isinstance(root, dict) else None
    if isinstance(docs, list):
        # One best recording, never concatenate timestamps from different edits.
        docs = sorted([d for d in docs if isinstance(d, dict)], key=lambda d: score(d, q), reverse=True)
        for doc in docs:
            rows = parse_provider(doc)
            if rows:
                return rows
        return []
    return parse_provider(root)


def kugou(q):
    keyword = f'{q.title} - {q.artist}' + (' '+q.album if q.album else '')
    root = data(q, 'https://mobileservice.kugou.com/api/v3/search/song',
                {'version': '9108', 'plat': '0', 'pagesize': '8', 'showtype': '0', 'keyword': keyword})
    songs = root.get('data', {}).get('info', [])
    songs = sorted([s for s in songs if not q.duration or abs((s.get('duration') or 0)-q.duration) <= 8],
                   key=lambda s: abs((s.get('duration') or 0)-q.duration))
    candidates = []
    for song in songs[:3]:
        found = data(q, 'https://lyrics.kugou.com/search', {'ver': '1', 'man': 'yes', 'client': 'pc', 'hash': song.get('hash')})
        candidates = found.get('candidates', [])
        if candidates:
            break
    if not candidates:
        found = data(q, 'https://lyrics.kugou.com/search', {'ver': '1', 'man': 'yes', 'client': 'pc', 'keyword': keyword, 'duration': q.duration*1000 or None})
        candidates = found.get('candidates', [])
    if not candidates:
        return []
    hit = candidates[0]
    root = data(q, 'https://lyrics.kugou.com/download', {'fmt': 'lrc', 'charset': 'utf8', 'client': 'pc', 'ver': '1',
                                                     'id': hit.get('id'), 'accesskey': hit.get('accesskey')})
    try:
        raw = base64.b64decode(root.get('content') or '', validate=True).decode('utf-8')
    except (ValueError, UnicodeError):
        return []
    rows = parse_provider(raw)
    # Metadata credit lines at either edge aren't sung lyrics.
    head = [i for i, r in enumerate(rows[:30]) if re.match(r'^[^:：]+[:：].+', r['text'])]
    if head:
        rows = rows[max(head)+1:]
    tail = [i for i in range(max(0, len(rows)-30), len(rows)) if re.match(r'^[^:：]+[:：].+', rows[i]['text'])]
    if tail:
        rows = rows[:min(tail)]
    return rows


def megalobiz(q):
    page = get(q, 'https://www.megalobiz.com/searchall', {'qry': q.artist+' '+q.title}) or ''
    match = re.search(r'''href=["'](/lrc/maker/download/[^"']+)["']''', page, re.I)
    if not match:
        return []
    page = get(q, 'https://www.megalobiz.com'+html.unescape(match[1])) or ''
    soup = BeautifulSoup(page, 'html.parser')
    node = soup.find(id=re.compile(r'^lrc_.*_details$'))
    if not node:
        return []
    for br in node.find_all('br'):
        br.replace_with('\n')
    return parse_provider(node.get_text())


def youtube(q, transcript=False):
    if not VIDEO_ID.fullmatch(q.video_id):
        return []
    # Same Innertube music requests as BitChord; no playback requests are made.
    context = {'client': {'clientName': 'WEB_REMIX', 'clientVersion': '1.20250101.01.00', 'hl': 'en', 'gl': 'US'}}
    headers = {'Origin': 'https://music.youtube.com', 'Referer': 'https://music.youtube.com/'}
    def post(endpoint, payload):
        return data(q, 'https://music.youtube.com/youtubei/v1/'+endpoint, headers=headers, payload={'context': context, **payload})
    if transcript:
        encoded = base64.b64encode(bytes([10, len(q.video_id)])+q.video_id.encode()).decode()
        root = post('get_transcript', {'params': encoded})
        return [line(int(c['startOffsetMs']), yt_text(c.get('cue')).strip(' \n♪'))
                for c in named(root, 'transcriptCueRenderer') if c.get('startOffsetMs') is not None and yt_text(c.get('cue')).strip(' \n♪')]
    root = post('next', {'videoId': q.video_id, 'isAudioOnly': True})
    tabs = named(root, 'tabRenderer')
    candidates = [t for t in tabs if str(t.get('title', '')).lower() == 'lyrics'] or tabs[1:2]
    endpoints = [e for tab in candidates for e in named(tab, 'browseEndpoint')]
    if not endpoints:
        return []
    root = post('browse', {k: endpoints[0][k] for k in ['browseId', 'params'] if k in endpoints[0]})
    shelves = named(root, 'musicDescriptionShelfRenderer')
    text = yt_text(shelves[0].get('description')) if shelves else ''
    return [line(0, text) for text in text.splitlines() if text.strip()]


def genius(q):
    queries = list(dict.fromkeys([q.artist+' '+q.title, q.artist+' '+re.sub(r'\([^)]*\)|\[[^]]*\]', '', q.title), q.title]))
    for query in queries:
        root = data(q, 'https://genius.com/api/search/multi', {'q': query})
        candidates = [h.get('result', {}) for s in root.get('response', {}).get('sections', []) if s.get('type') == 'song' for h in s.get('hits', [])]
        candidates = [c for c in candidates if score(c, q) >= 20 and not any(v in c.get('path', '').lower() for v in ['translation', 'tracklist', 'album-art'])]
        best = max(candidates, key=lambda c: score(c, q), default=None)
        if not best:
            continue
        url = best.get('url') or ''
        if urlsplit(url).hostname not in {'genius.com', 'www.genius.com'}:
            continue
        page = get(q, url)
        if not page:
            continue
        soup = BeautifulSoup(page, 'html.parser')
        nodes = soup.select('div[data-lyrics-container="true"]') or soup.select('div.lyrics')
        rows = []
        for node in nodes:
            for extra in node.select('[data-exclude-from-selection="true"], button, script, style, .LyricsHeader__Container, .SongBioPreview__Container, .InreadAd__Container'):
                extra.decompose()
            for br in node.find_all('br'):
                br.replace_with('\n')
            text = node.get_text().replace('You might also like', '')
            text = re.sub(r'\d*Embed\s*$', '', text)
            rows.extend(line(0, s) for s in text.splitlines() if s.strip())
        if rows:
            return rows
    return []


def mxm_sign(url, secret):
    url = url.replace('%20', '+').replace(' ', '+')
    day = datetime.now(timezone.utc).strftime('%Y%m%d')
    signature = base64.b64encode(hmac.new(secret.encode(), (url+day).encode(), hashlib.sha256).digest()).decode()
    return url+'&'+urlencode({'signature': signature, 'signature_protocol': 'sha256'})


def musixmatch(q):
    global MXM_SECRET, MXM_TOKEN
    base = 'https://apic.musixmatch.com/ws/1.1/'
    if not MXM_SECRET:
        page = get(q, 'https://www.musixmatch.com/search') or ''
        script = re.search(r'''src=["']([^"']*/_next/static/chunks/pages/_app-[^"']+\.js)["']''', page, re.I)
        if script:
            raw = get(q, urljoin('https://www.musixmatch.com/search', script[1])) or ''
            encoded = re.search(r'''from\(\s*["']([^"']+)["']\s*\.split''', raw)
            if encoded:
                try:
                    MXM_SECRET = base64.b64decode(encoded[1][::-1]).decode()
                except (ValueError, UnicodeError):
                    pass
        # Public client fallback shipped by BitChord, not a user's API credential.
        MXM_SECRET = MXM_SECRET or 'f09016176ba43a1cfd1031fbd6b3d26c'
    def call(endpoint, params, token=True):
        global MXM_TOKEN
        query = {'app_id': 'mobile-app-v1.0', 'format': 'json', **params}
        if token:
            query['usertoken'] = MXM_TOKEN
        root = data(q, mxm_sign(base+endpoint+'?'+urlencode(query), MXM_SECRET))
        message = root.get('message') or {}
        if message.get('header', {}).get('status_code') in [401, 402]:
            MXM_TOKEN = None
            return {}
        return message.get('body') or {}
    if not MXM_TOKEN:
        MXM_TOKEN = call('token.get', {'guid': GUID}, False).get('user_token')
    if not MXM_TOKEN:
        return []
    root = call('track.search', {'q_track': q.title, 'q_artist': q.artist, 'f_has_lyrics': 1,
                               's_track_rating': 'desc', 'quorum_factor': 1, 'page_size': 10, 'page': 1})
    best = best_item(root, q)
    if not best:
        return []
    identity = best.get('track_id')
    if best.get('has_richsync'):
        body = call('track.richsync.get', {'track_id': identity}).get('richsync', {}).get('richsync_body')
        rows = parse_richsync(body)
        if rows:
            return rows
    body = call('track.subtitle.get', {'track_id': identity, 'subtitle_format': 'mxm'}).get('subtitle', {}).get('subtitle_body')
    try:
        return [line(round(float(r['time']['total'])*1000), r['text']) for r in json.loads(body or '[]') if r.get('text')]
    except (ValueError, TypeError, KeyError):
        return []


def fetch_source(source, q, hit=None):
    providers = {
        'BINI_LYRICS': lambda: bini(q, hit), 'BETTER_LYRICS': lambda: better(q),
        'BETTER_LYRICS_PORTATO': lambda: better(q, True), 'PAXSENIX': lambda: pax(q),
        'PAXSENIX_SPOTIFY': lambda: pax(q, 'spotify'), 'PAXSENIX_MUSIXMATCH': lambda: pax(q, 'musixmatch'),
        'LYRICS_PLUS': lambda: lyrics_plus(q), 'SIMP_MUSIC': lambda: simpmusic(q), 'UNISON': lambda: unison(q),
        'YOUTUBE_TRANSCRIPT': lambda: youtube(q, True), 'YOUTUBE_MUSIC': lambda: youtube(q),
        'MEGALOBIZ': lambda: megalobiz(q), 'KUGOU': lambda: kugou(q), 'LRCLIB': lambda: lrclib(q),
        'MUSIXMATCH': lambda: musixmatch(q), 'GENIUS': lambda: genius(q),
    }
    try:
        return result_payload(providers[source](), dict(SOURCES)[source], q.duration*1000)
    except Exception:
        # Third-party response formats change independently; one miss cannot cancel the race.
        return None


def lookup(q):
    hit = None
    if not q.isrc:
        try:
            hit = identify(replace(q, deadline=time.monotonic()+2.5))
            if hit and hit.get('isrc'):
                q = replace(q, isrc=hit['isrc'])
        except Exception:
            pass
    now = time.monotonic()
    jobs = {}
    for source, _ in SOURCES:
        if source == 'GENIUS':
            continue
        timeout = 15 if source in {'PAXSENIX_SPOTIFY', 'PAXSENIX_MUSIXMATCH'} and pax_key() else 8
        jobs[source] = POOL.submit(fetch_source, source, replace(q, deadline=now+timeout), hit)
    fallback = None
    try:
        for source, _ in SOURCES:
            if source == 'GENIUS':
                # Plain web scraping is lazy, as in BitChord.
                return fallback or fetch_source(source, replace(q, deadline=time.monotonic()+8))
            try:
                found = jobs[source].result(timeout=max(.01, now+15-time.monotonic()))
            except Exception:
                continue
            if found and found['synced']:
                return found
            if found and fallback is None:
                fallback = found
    finally:
        for job in jobs.values():
            job.cancel()
    return fallback


@lyrics_blueprint.get('/api/bitchord-lyrics')
def lyrics_route():
    title, artist = request.args.get('title', '').strip(), request.args.get('artist', '').strip()
    if not title or not artist or max(len(title), len(artist), len(request.args.get('album', ''))) > 400:
        return jsonify({'error': 'title and artist are required (maximum 400 characters each)'}), 400
    try:
        duration = max(0, min(14400, int(float(request.args.get('duration', '0')))))
    except (ValueError, OverflowError):
        return jsonify({'error': 'invalid duration'}), 400
    video = request.args.get('videoId', '')
    isrc = request.args.get('isrc', '')
    apple = request.args.get('appleId', '')
    if (video and not VIDEO_ID.fullmatch(video)) or len(isrc) > 32 or len(apple) > 32:
        return jsonify({'error': 'invalid recording identifier'}), 400
    q = Query(clean_title(title), re.sub(r'\s*-\s*Topic$', '', artist, flags=re.I), request.args.get('album', '').strip(),
              duration, video, isrc, apple)
    key = hashlib.sha256(repr(q).encode()).hexdigest()
    with LOCK:
        cached = CACHE.get(key)
        if cached and cached[0] > time.monotonic():
            return jsonify(cached[1])
        pending = INFLIGHT.get(key)
        owner = pending is None
        if owner:
            pending = futures.Future()
            INFLIGHT[key] = pending
    if not owner:
        try:
            body, status = pending.result(timeout=28)
            return jsonify(body), status
        except futures.TimeoutError:
            return jsonify({'error': 'lyrics lookup timed out'}), 504
    try:
        if not LOOKUPS.acquire(blocking=False):
            body, status = {'error': 'lyrics service busy; try again shortly'}, 503
        else:
            try:
                found = lookup(q)
                body, status = (found, 200) if found else ({'unavailable': True}, 404
                )
                if found:
                    with LOCK:
                        if len(CACHE) >= 128:
                            CACHE.pop(next(iter(CACHE)))
                        CACHE[key] = (time.monotonic()+900, found)
            finally:
                LOOKUPS.release()
        pending.set_result((body, status))
        return jsonify(body), status
    except Exception:
        body = {'error': 'lyrics lookup failed'}
        pending.set_result((body, 502))
        return jsonify(body), 502
    finally:
        with LOCK:
            INFLIGHT.pop(key, None)
