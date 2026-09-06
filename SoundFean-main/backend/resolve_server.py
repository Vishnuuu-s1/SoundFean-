#!/usr/bin/env python3
"""
SoundFean YouTube track resolver.

Keeps Tidal metadata untouched. Only resolves title/artist/album → YouTube videoId
using ytmusicapi, with on-disk cache so searches are not repeated.

Run:
  pip install ytmusicapi flask
  python resolve_server.py

Env:
  RESOLVE_PORT=8765 (default)
  RESOLVE_CACHE_PATH=./yt_resolve_cache.sqlite
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from typing import Any

from flask import Flask, jsonify, request
from flask_cors import CORS

try:
    from ytmusicapi import YTMusic
except ImportError:
    raise SystemExit(
        "ytmusicapi is required. Install with: pip install ytmusicapi flask flask-cors"
    )

app = Flask(__name__)
CORS(app)

CACHE_PATH = os.environ.get("RESOLVE_CACHE_PATH", os.path.join(os.path.dirname(__file__), "yt_resolve_cache.sqlite"))
PORT = int(os.environ.get("RESOLVE_PORT", "8765"))

yt = YTMusic()  # unauthenticated is enough for search


def _norm(s: str | None) -> str:
    if not s:
        return ""
    s = s.lower().strip()
    s = re.sub(r"[\(\[].*?[\)\]]", "", s)  # drop (feat. …) / [remaster]
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def cache_key(title: str, artist: str, album: str = "") -> str:
    raw = f"{_norm(title)}|{_norm(artist)}|{_norm(album)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def init_db() -> None:
    conn = sqlite3.connect(CACHE_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS matches (
            key TEXT PRIMARY KEY,
            title TEXT,
            artist TEXT,
            album TEXT,
            video_id TEXT,
            yt_title TEXT,
            yt_artist TEXT,
            confidence REAL,
            created_at REAL,
            payload TEXT
        )
        """
    )
    conn.commit()
    conn.close()


def get_cached(key: str) -> dict[str, Any] | None:
    conn = sqlite3.connect(CACHE_PATH)
    row = conn.execute(
        "SELECT video_id, yt_title, yt_artist, confidence, payload FROM matches WHERE key = ?",
        (key,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    video_id, yt_title, yt_artist, confidence, payload = row
    if payload:
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            pass
    return {
        "youtubeVideoId": video_id,
        "ytTitle": yt_title,
        "ytArtist": yt_artist,
        "confidence": confidence,
        "playbackSource": "youtube",
    }


def set_cached(key: str, title: str, artist: str, album: str, result: dict[str, Any]) -> None:
    conn = sqlite3.connect(CACHE_PATH)
    conn.execute(
        """
        INSERT OR REPLACE INTO matches
        (key, title, artist, album, video_id, yt_title, yt_artist, confidence, created_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            key,
            title,
            artist,
            album,
            result.get("youtubeVideoId"),
            result.get("ytTitle"),
            result.get("ytArtist"),
            result.get("confidence", 0),
            time.time(),
            json.dumps(result),
        ),
    )
    conn.commit()
    conn.close()


def score_candidate(item: dict, title: str, artist: str, album: str) -> float:
    """Higher is better. Prefer official songs / videos that match title+artist."""
    yt_title = _norm(item.get("title") or "")
    yt_artists = item.get("artists") or []
    yt_artist = _norm(" ".join(a.get("name", "") for a in yt_artists if isinstance(a, dict)))
    if not yt_artist and item.get("artist"):
        yt_artist = _norm(str(item["artist"]))

    n_title = _norm(title)
    n_artist = _norm(artist)

    score = 0.0

    # Title similarity
    if n_title and yt_title:
        if n_title == yt_title:
            score += 0.55
        elif n_title in yt_title or yt_title in n_title:
            score += 0.35
        else:
            # token overlap
            t1, t2 = set(n_title.split()), set(yt_title.split())
            if t1 and t2:
                score += 0.25 * (len(t1 & t2) / max(len(t1 | t2), 1))

    # Artist similarity
    if n_artist and yt_artist:
        if n_artist == yt_artist:
            score += 0.35
        elif n_artist in yt_artist or yt_artist in n_artist:
            score += 0.22
        else:
            a1, a2 = set(n_artist.split()), set(yt_artist.split())
            if a1 and a2:
                score += 0.15 * (len(a1 & a2) / max(len(a1 | a2), 1))

    # Prefer songs over videos when available
    result_type = (item.get("resultType") or item.get("category") or "").lower()
    if result_type == "song":
        score += 0.08
    elif result_type == "video":
        score += 0.02

    # Prefer official / topic channels lightly
    album_name = ""
    if item.get("album") and isinstance(item["album"], dict):
        album_name = _norm(item["album"].get("name") or "")
    if album and album_name and (_norm(album) in album_name or album_name in _norm(album)):
        score += 0.05

    # Duration sanity (songs usually 30s–15min)
    duration = item.get("duration") or item.get("duration_seconds")
    if isinstance(duration, str) and ":" in duration:
        parts = duration.split(":")
        try:
            secs = int(parts[-1]) + 60 * int(parts[-2])
            if len(parts) == 3:
                secs += 3600 * int(parts[0])
            if 30 <= secs <= 900:
                score += 0.03
        except ValueError:
            pass

    return min(score, 1.0)


def search_youtube(title: str, artist: str, album: str = "") -> dict[str, Any] | None:
    queries = []
    if artist and title:
        queries.append(f"{artist} {title}")
        queries.append(f"{title} {artist}")
    if album and artist and title:
        queries.append(f"{artist} {title} {album}")
    if title:
        queries.append(title)

    best: dict[str, Any] | None = None
    best_score = 0.0

    for q in queries:
        try:
            # Prefer songs filter when available
            results = yt.search(q, filter="songs", limit=8)
            if not results:
                results = yt.search(q, limit=8)
        except Exception as e:
            print(f"[resolve] search error for {q!r}: {e}")
            continue

        for item in results or []:
            video_id = item.get("videoId")
            if not video_id:
                continue
            s = score_candidate(item, title, artist, album)
            if s > best_score:
                best_score = s
                yt_artists = item.get("artists") or []
                yt_artist = ", ".join(
                    a.get("name", "") for a in yt_artists if isinstance(a, dict)
                ) or item.get("artist") or ""
                best = {
                    "youtubeVideoId": video_id,
                    "ytTitle": item.get("title") or "",
                    "ytArtist": yt_artist,
                    "confidence": round(s, 3),
                    "playbackSource": "youtube",
                    "resultType": item.get("resultType") or item.get("category"),
                }

        # Early exit on strong match
        if best_score >= 0.85:
            break

    # Require reasonable confidence — do not return random songs
    if best and best_score >= 0.45:
        return best
    return None


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "soundfean-yt-resolve"})


@app.route("/api/resolve-track", methods=["GET", "POST"])
def resolve_track():
    """
    Input (query or JSON body):
      title, artist, album (optional), cover (optional — echoed back)

    Response on success:
      {
        "title", "artist", "album", "cover",   # originals echoed
        "youtubeVideoId", "playbackSource": "youtube",
        "confidence", "ytTitle", "ytArtist", "cached"
      }

    On failure:
      { "unavailable": true, "reason": "..." }
    """
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
    else:
        data = request.args.to_dict()

    title = (data.get("title") or "").strip()
    artist = (data.get("artist") or "").strip()
    album = (data.get("album") or "").strip()
    cover = data.get("cover")  # pass-through; never replaced

    if not title:
        return jsonify({"unavailable": True, "reason": "missing title"}), 400

    key = cache_key(title, artist, album)
    cached = get_cached(key)
    if cached and cached.get("youtubeVideoId"):
        return jsonify(
            {
                "title": title,
                "artist": artist,
                "album": album,
                "cover": cover,
                **cached,
                "cached": True,
            }
        )

    match = search_youtube(title, artist, album)
    if not match:
        return jsonify(
            {
                "unavailable": True,
                "reason": "no confident YouTube match",
                "title": title,
                "artist": artist,
                "album": album,
                "cover": cover,
            }
        ), 404

    set_cached(key, title, artist, album, match)
    return jsonify(
        {
            "title": title,
            "artist": artist,
            "album": album,
            "cover": cover,
            **match,
            "cached": False,
        }
    )


if __name__ == "__main__":
    init_db()
    print(f"SoundFean YT resolve server on http://127.0.0.1:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
