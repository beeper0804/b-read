"""Pair a user-approved HTTPS reader with its loopback assistant."""
from hmac import compare_digest
from pathlib import Path
import re
from secrets import token_urlsafe
from threading import Lock
from time import monotonic
from urllib.parse import urlsplit, urlunsplit

PAIR_SECONDS = 600
SESSION_SECONDS = 8 * 60 * 60
TOKEN = re.compile(r"[A-Za-z0-9_-]{16,64}")
DOMAIN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", re.I)


def website_url(raw):
    if not raw or len(raw) > 2048 or any(not 33 <= ord(char) < 127 for char in raw) or "\\" in raw:
        raise ValueError("Enter the full HTTPS address of your B-read website.")
    try:
        parts = urlsplit(raw)
        host = parts.hostname or ""
        if (parts.scheme != "https" or not DOMAIN.fullmatch(host) or
                parts.netloc.lower() not in (host, host + ":443") or parts.query or parts.fragment):
            raise ValueError
    except ValueError:
        raise ValueError("Enter the full HTTPS address of your B-read website.") from None
    return urlunsplit(("https", host, parts.path or "/", "", ""))


def configured_website(location, change=False):
    file = Path(location)
    if not change and file.is_file():
        try:
            return website_url(file.read_text(encoding="utf-8").strip())
        except ValueError:
            pass
    while True:
        try:
            address = website_url(input("Paste the B-read website address (https://...): ").strip())
            break
        except ValueError as error:
            print(error)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(address + "\n", encoding="utf-8")
    return address


class WebsiteBridge:
    def __init__(self, address, announce, clock=monotonic):
        self.address = website_url(address)
        self.origin = "https://" + urlsplit(self.address).netloc
        self.clock = clock
        self._announce = announce
        self.lock = Lock()
        self._code = None
        self._session = None

    def issue_code(self):
        with self.lock:
            self._code = (token_urlsafe(18), self.clock() + PAIR_SECONDS)
            self._announce(self._code[0])

    def pair(self, code):
        if not isinstance(code, str) or not TOKEN.fullmatch(code):
            return
        with self.lock:
            if not self._code:
                return
            expected, expires = self._code
            if expires <= self.clock() or not compare_digest(code, expected):
                return
            self._code = None
            session = token_urlsafe(24)
            self._session = (session, self.clock() + SESSION_SECONDS)
            return session

    def authenticated(self, session):
        if not isinstance(session, str) or not TOKEN.fullmatch(session):
            return False
        with self.lock:
            return self._valid(session)

    def _valid(self, session):
        return bool(self._session and self._session[1] > self.clock() and compare_digest(session, self._session[0]))

    def disconnect(self, session):
        if not isinstance(session, str) or not TOKEN.fullmatch(session):
            return
        with self.lock:
            if not self._valid(session):
                return
            self._session = None
            self._code = (token_urlsafe(18), self.clock() + PAIR_SECONDS)
            self._announce(self._code[0])
