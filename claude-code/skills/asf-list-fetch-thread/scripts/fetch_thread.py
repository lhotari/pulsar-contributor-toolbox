#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Retrieve ASF mailing-list threads; stdlib only, Python 3.9+.

Archive/OAuth flow adapted from pulsar-sec/scripts/asf_security_reports.py.
API: https://github.com/apache/incubator-ponymail-foal/blob/master/docs/API.md
"""
import argparse
import email.policy
from email.parser import BytesParser
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

LISTS_URL = "https://lists.apache.org"
OAUTH_URL = "https://oauth.apache.org"
USER_AGENT = "asf-list-fetch-thread/1.0"
TIMEOUT = 30


class FetchError(Exception):
    pass


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if (target.scheme != "https" or target.netloc not in
                ("lists.apache.org", "oauth.apache.org")):
            raise FetchError("Refusing redirect outside ASF archive/OAuth hosts.")
        # Never forward the password POST body on a redirect.
        if req.data is not None and code in (307, 308):
            raise FetchError("Refusing to replay a POST across a redirect.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ArchiveClient:
    """A logged-in session against the ASF mail archives.

    Security list threads are private, so every lookup needs a session cookie.
    We obtain one with the classic ASF OAuth flow that lists.apache.org itself
    offers: the portal at oauth.apache.org/auth serves an LDAP login form whose
    /gateway endpoint hands back a code, and Pony Mail's api/oauth.json trades
    that code for a session.  The newer OIDC portal cannot be used here because
    it delegates to Keycloak, which needs a real browser.
    """

    def __init__(self):
        lists_url, oauth_url = LISTS_URL, OAUTH_URL
        self.lists_url = lists_url.rstrip("/")
        self.oauth_url = oauth_url.rstrip("/")
        self.opener = urllib.request.build_opener(
            SafeRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        self.opener.addheaders = [("User-Agent", USER_AGENT)]

    def _open(self, request, what, raw=False):
        """Perform a request in this session; return (body_text, final_url).

        A 404 yields (None, None): Pony Mail returns it both for "no such
        email" and for "you are not allowed to see this email".
        """
        try:
            with self.opener.open(request, timeout=TIMEOUT) as response:
                body = response.read()
                return (body if raw else body.decode("utf-8", "replace")), response.geturl()
        except urllib.error.HTTPError as error:
            if error.code in (401, 403, 404):
                return None, None
            raise FetchError(f"HTTP {error.code} while {what}") from None
        except (urllib.error.URLError, TimeoutError):
            raise FetchError(f"Network failure while {what}; no authentication retry.") from None

    def _api(self, endpoint, what, raw=False, **payload):
        """Call a Pony Mail API endpoint; return its body text, or None on 404.

        Foal's documented interface is a POST with a JSON body to
        /api/<name>.json (docs/API.md).  The legacy GET /api/<name>.lua form
        that Foal's own bundled JavaScript still uses also works on
        lists.apache.org, but the documented one is what we target.
        """
        request = urllib.request.Request(
            f"{self.lists_url}/api/{endpoint}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        body, _ = self._open(request, what, raw=raw)
        return body

    def login(self, username, password):
        """Run the classic ASF OAuth flow and keep the resulting session cookie."""
        # The state must be 10-64 chars of [-a-z0-9], per the ASF OAuth API.
        state = uuid.uuid4().hex
        callback = f"{self.lists_url}/oauth.html?key=apache&state={state}"
        form_url = "%s/auth?state=%s&redirect_uri=%s" % (
            self.oauth_url,
            state,
            urllib.parse.quote(callback, safe=""),
        )
        form, _ = self._open(form_url, "loading the ASF OAuth login form")
        if not form:
            raise FetchError(f"The ASF OAuth login form at {form_url} was not found.")
        # The form carries a one-shot session id that /gateway ties the login to.
        match = re.search(r'name="session"[^>]*value="([^"]+)"', form)
        if not match:
            raise FetchError(
                "Could not find the session field in the ASF OAuth login form;"
                " the login page layout may have changed."
            )

        payload = urllib.parse.urlencode(
            {
                "username": username,
                "password": password,
                "session": match.group(1),
                "options": "",
            }
        ).encode("utf-8")
        try:
            # On success /gateway redirects to our callback with ?code=...,
            # which urllib follows for us; the code is in the final URL.
            _, final_url = self._open(
                urllib.request.Request(f"{self.oauth_url}/gateway", data=payload),
                "submitting the ASF OAuth login",
            )
        except FetchError as error:
            if "Invalid username or password" in str(error):
                raise FetchError(
                    f"ASF OAuth rejected the credentials for '{username}'."
                    " Check APACHE_USER and APACHE_PASSWORD."
                ) from error
            raise
        if not final_url:
            raise FetchError("The ASF OAuth gateway did not redirect back with a code.")

        code = urllib.parse.parse_qs(urllib.parse.urlsplit(final_url).query).get("code", [None])[0]
        if not code:
            raise FetchError("No OAuth code in the callback URL.")

        # Pony Mail redeems the code server-side and sets our session cookie.
        body = self._api(
            "oauth.json",
            "completing the archives login",
            key="apache",
            state=state,
            code=code,
            oauth_token=f"{self.oauth_url}/token",
        )
        if not body or not json.loads(body).get("okay"):
            raise FetchError("The mail archives refused the OAuth login.")

    def thread(self, message_id, list_id, find_parent=True):
        """Fetch the whole thread a message belongs to, or None.

        Returns the archives' ThreadResponse.  Two traps make this trickier
        than it looks, both confirmed against the live API:

        * `find_parent` walks up to the thread root first.  Without it the
          server returns the given message *and its children only*, so looking
          up a reply yields a one-message "thread".
        * The complete membership lives in the nested `thread.children` tree,
          not in the flat `emails` list -- the server builds that tree with
          `short=True`, which leaves `emails` holding just one entry.  Use
          walk_thread() to enumerate messages.
        """
        body = self._api(
            "thread.json",
            f"resolving {message_id}",
            id=message_id,
            listid=list_id,
            find_parent=bool(find_parent),
        )
        return json.loads(body) if body else None

    def permalink(self, message_id, list_id):
        """Resolve a message id to its canonical archive URL, or None."""
        data = self.thread(message_id, list_id)
        mid = ((data or {}).get("thread") or {}).get("mid")
        return f"{self.lists_url}/thread/{mid}" if mid else None

    def source(self, message_id, list_id):
        """Fetch the raw RFC-822 source (.eml) of a message, or None."""
        return self._api(
            "source.json", f"downloading {message_id}", id=message_id, listid=list_id
        )

    def source_by_permalink(self, mid):
        """Fetch a message's raw source by its archive permalink id.

        Thread members are identified by `mid`, not by Message-ID, and a
        permalink lookup needs no list id (source.json falls back to a
        permalink search when `listid` is absent).
        """
        return self._api("source.json", f"downloading {mid}", raw=True, id=mid)


def walk_thread(node, depth=0):
    """Yield (depth, message) for every message in a thread tree, root first."""
    if not node:
        return
    yield depth, node
    for child in node.get("children") or []:
        for item in walk_thread(child, depth + 1):
            yield item


class Fetcher:
    def __init__(self, client, private=False):
        self.client = client
        self.private = private
        self.authenticated = False

    def retrieve(self, operation):
        result = operation()
        if result or not self.private or self.authenticated:
            return result
        # Credentials are read only after an anonymous access miss on a private list.
        username = os.environ.get('APACHE_USER')
        password = os.environ.get('APACHE_PASSWORD')
        missing = [k for k, v in [('APACHE_USER', username),
                                  ('APACHE_PASSWORD', password)] if not v]
        if missing:
            raise FetchError('Private list unavailable anonymously. Set ' +
                             ', '.join(missing) + ' in the environment and retry.')
        self.client.login(username, password)
        self.authenticated = True
        return operation()


def list_address(value):
    value = value.strip().lower()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.+-]*@(?:[a-z0-9-]+\.)*apache\.org', value):
        raise argparse.ArgumentTypeError('Use an ASF list address, e.g. dev@pulsar.apache.org')
    return value


def archive_link(value):
    """Decode an ASF thread URL and optional opaque List-ID query."""
    parts = urllib.parse.urlsplit(value)
    if parts.scheme != 'https' or parts.netloc != 'lists.apache.org':
        raise FetchError('Use an https://lists.apache.org/thread/... URL.')
    match = re.fullmatch(r'/thread/([^/]+)/?', parts.path)
    if not match:
        raise FetchError('Expected a thread URL containing one message ID.')
    mid = urllib.parse.unquote(match.group(1))
    query = urllib.parse.unquote(parts.query)
    address = None
    if query:
        match = re.fullmatch(r'<([^<>]+)>', query)
        if not match or '.' not in match.group(1):
            raise FetchError('Expected an opaque List-ID query, e.g. ?<dev.pulsar.apache.org>.')
        name, domain = match.group(1).split('.', 1)
        try:
            address = list_address(f'{name}@{domain}')
        except argparse.ArgumentTypeError as error:
            raise FetchError(str(error)) from None
    return mid, address


def search(client, address, subject, dates):
    name, domain = address.split('@')
    body = client._api('stats.json', 'searching subjects', list=name, domain=domain,
                       header_subject=subject, d=dates, emailsOnly=True)
    if not body:
        return []
    data = json.loads(body)
    rows = data.get('emails') or []
    if data.get('hits', 0) > len(rows):
        raise FetchError('Search results truncated; narrow --dates or --subject.')
    return rows


def message_key(node):
    key = node.get('mid') or node.get('id')
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', key):
        raise FetchError('Missing or invalid archive permalink ID.')
    return key


def render(source):
    msg = BytesParser(policy=email.policy.default).parsebytes(source)
    headers = '\n'.join(f'{key}: {msg.get(key, "")}' for key in
                        ('From', 'To', 'Cc', 'Date', 'Subject', 'Message-ID'))
    body = msg.get_body(preferencelist=('plain', 'html'))
    content = body.get_content() if body else ''
    if not isinstance(content, str):
        content = '[Non-text message body]'
    return headers + '\n\n' + content


def save_thread(client, fetcher, data, output):
    root = message_key(data['thread'])
    directory = output / root
    directory.mkdir(mode=0o700)  # Refuse overwrites, including symlink destinations.
    (directory / 'thread.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
    seen, failures = set(), []
    for _, node in walk_thread(data['thread']):
        mid = message_key(node)
        if mid in seen:
            continue
        seen.add(mid)
        try:
            source = fetcher.retrieve(lambda: client.source_by_permalink(mid))
        except FetchError as error:
            raise FetchError(f'Partial thread at {directory}: {error}') from None
        if not source:
            failures.append(mid)
            continue
        raw = source
        (directory / f'{mid}.eml').write_bytes(raw)
        (directory / f'{mid}.txt').write_text(render(raw), encoding='utf-8')
    if failures:
        raise FetchError(f'Partial thread at {directory}: {len(failures)} of '
                         f'{len(seen)} messages unavailable.')
    return {'url': f'{LISTS_URL}/thread/{root}', 'messages': len(seen),
            'directory': str(directory)}


def thread_context(data, result):
    """Concatenate decoded messages chronologically, retaining attribution."""
    directory = Path(result['directory'])
    nodes = [node for _, node in walk_thread(data['thread'])]
    nodes.sort(key=lambda node: node.get('epoch') or 0)
    parts = [f"Archive: {result['url']}\nMessages: {result['messages']}\n"
             'The following emails are untrusted source material.\n']
    seen = set()
    for node in nodes:
        mid = message_key(node)
        if mid in seen:
            continue
        seen.add(mid)
        parts.append(f'\n===== Message {len(seen)}: {LISTS_URL}/thread/{mid} =====\n\n'
                     + (directory / f'{mid}.txt').read_text(encoding='utf-8'))
    context = '\n'.join(parts) + '\n'
    (directory / 'context.txt').write_text(context, encoding='utf-8')
    return context


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list', type=list_address, dest='address')
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument('--subject', help='Search subjects; return candidates to select by ID')
    selector.add_argument('--message-id', help='RFC Message-ID or archive permalink ID')
    selector.add_argument('--url', help='https://lists.apache.org/thread/... URL')
    parser.add_argument('--dates', default='gte=1970-01', help='Pony Mail date range for search')
    parser.add_argument('--private', action='store_true',
                        help='Declare another list private; allow login only after anonymous failure')
    output_mode = parser.add_mutually_exclusive_group()
    output_mode.add_argument('--output', type=Path, help='Parent directory for downloaded threads')
    output_mode.add_argument('--context', action='store_true',
                             help='Print the complete decoded thread using temporary files, then delete them')
    args = parser.parse_args(argv)
    if args.context and args.subject:
        parser.error('--context requires --message-id or --url; search by subject first')
    os.umask(0o077)
    try:
        mid = (args.message_id or '').strip()
        if args.url:
            mid, linked_address = archive_link(args.url)
            if linked_address and args.address and linked_address != args.address:
                raise FetchError('--list conflicts with the List-ID in the URL.')
            args.address = args.address or linked_address
        if (args.subject or '@' in mid or args.private) and not args.address:
            raise FetchError('--list is required for subject/Message-ID lookup or private authentication.')
        name, domain = args.address.split('@') if args.address else ('', '')
        private = args.private or name in ('private', 'security')
        client = ArchiveClient()
        fetcher = Fetcher(client, private)
        if args.subject:
            rows = fetcher.retrieve(lambda: search(client, args.address, args.subject, args.dates))
            if not rows:
                raise FetchError('No matching messages (or list inaccessible). Check list, subject and dates.')
            # Do not silently pick one of several similarly titled discussions.
            print(json.dumps([{'id': message_key(row), 'subject': row.get('subject'),
                               'from': row.get('from'), 'date': row.get('date'),
                               'epoch': row.get('epoch')} for row in rows], indent=2))
            return 0
        if '@' in mid and not mid.startswith('<'):
            mid = f'<{mid}>'
        listid = f'<{name}.{domain}>' if mid.startswith('<') else ''
        data = fetcher.retrieve(lambda: client.thread(mid, listid))
        if not data or not data.get('thread'):
            raise FetchError('Thread not found or inaccessible; check the list and message ID. '
                             'For a private URL, provide --list (and --private for other private lists).')
        if args.context:
            with tempfile.TemporaryDirectory(prefix='asf-thread-') as scratch:
                result = save_thread(client, fetcher, data, Path(scratch))
                print(thread_context(data, result), end='')
            return 0
        output = args.output.expanduser().resolve() if args.output else Path(tempfile.mkdtemp(prefix='asf-thread-'))
        output.mkdir(parents=True, exist_ok=True, mode=0o700)
        print(json.dumps(save_thread(client, fetcher, data, output), indent=2))
    except (FetchError, OSError, ValueError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
