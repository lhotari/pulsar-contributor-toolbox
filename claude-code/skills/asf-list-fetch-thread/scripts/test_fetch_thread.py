"""Offline credential-boundary and complete-download regression checks."""
import os
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from fetch_thread import Fetcher, FetchError, SafeRedirect, archive_link, main, save_thread
import urllib.request


class FetchTests(unittest.TestCase):
    def test_public_miss_never_reads_credentials(self):
        client = Mock()
        with patch('fetch_thread.os.environ.get', side_effect=AssertionError('credential read')):
            self.assertIsNone(Fetcher(client).retrieve(lambda: None))
        client.login.assert_not_called()

    def test_private_publicly_accessible_never_reads_credentials(self):
        with patch('fetch_thread.os.environ.get', side_effect=AssertionError('credential read')):
            self.assertEqual(Fetcher(Mock(), True).retrieve(lambda: 'mail'), 'mail')

    def test_private_retries_once_after_anonymous_miss(self):
        client = Mock()
        fetcher = Fetcher(client, True)
        operation = Mock(side_effect=[None, 'mail'])
        with patch.dict(os.environ, APACHE_USER='test', APACHE_PASSWORD='dummy'):
            self.assertEqual(fetcher.retrieve(operation), 'mail')
        client.login.assert_called_once_with('test', 'dummy')
        self.assertIsNone(fetcher.retrieve(lambda: None))
        client.login.assert_called_once()

    def test_missing_password(self):
        client = Mock()
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(FetchError, 'APACHE_PASSWORD'):
            Fetcher(client, True).retrieve(lambda: [])
        client.login.assert_not_called()

    def test_network_failure_never_logs_in(self):
        client = Mock()
        with self.assertRaises(FetchError):
            Fetcher(client, True).retrieve(Mock(side_effect=FetchError('network')))
        client.login.assert_not_called()

    def test_nested_download_preserves_source_and_permissions(self):
        client = Mock()
        raw = b'From: a@example.org\nContent-Type: text/plain; charset=iso-8859-1\n\n\xff\n'
        client.source_by_permalink.return_value = raw
        data = {'thread': {'mid': 'root', 'children': [{'mid': 'reply', 'children': [{'mid': 'last'}]}]},
                'emails': [{'mid': 'root'}]}
        with tempfile.TemporaryDirectory() as directory, patch('builtins.print'):
            old = os.umask(0o077)
            try:
                save_thread(client, Fetcher(client), data, Path(directory))
            finally:
                os.umask(old)
            files = list(Path(directory).rglob('*.eml'))
            self.assertEqual(len(files), 3)
            for file in files:
                self.assertEqual(file.read_bytes(), raw)
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_password_redirect_blocked(self):
        request = urllib.request.Request('https://oauth.apache.org/gateway', data=b'password=dummy')
        for status, url in [(302, 'https://example.com/'), (307, 'https://lists.apache.org/oauth.html')]:
            with self.assertRaises(FetchError):
                SafeRedirect().redirect_request(request, None, status, '', {}, url)

    def test_context_outputs_every_message_in_order_and_cleans_up(self):
        client = Mock()
        client.thread.return_value = {'thread': {'mid': 'root', 'epoch': 1, 'children': [
            {'mid': 'later', 'epoch': 3}, {'mid': 'earlier', 'epoch': 2},
            {'mid': 'later', 'epoch': 3}]}}
        client.source_by_permalink.side_effect = lambda mid: (
            f'From: {mid}@example.org\nSubject: Vote\nContent-Type: text/plain; charset=utf-8\n'
            f'Content-Transfer-Encoding: base64\n\n'
            + {'root': 'T3BlbmluZw==', 'later': 'KzE=', 'earlier': 'LTA='}[mid]
        ).encode()
        paths = []
        real_save = save_thread

        def record_save(*args):
            result = real_save(*args)
            paths.append(Path(result['directory']))
            return result

        stdout = io.StringIO()
        with patch('fetch_thread.ArchiveClient', return_value=client), \
                patch('fetch_thread.save_thread', side_effect=record_save), \
                patch('sys.stdout', stdout):
            self.assertEqual(main(['--url', 'https://lists.apache.org/thread/root',
                                   '--context']), 0)
        output = stdout.getvalue()
        self.assertEqual(output.count('===== Message'), 3)
        self.assertLess(output.index('earlier@example.org'), output.index('later@example.org'))
        self.assertIn('Opening', output)
        self.assertIn('+1', output)
        self.assertTrue(paths)
        self.assertFalse(paths[0].parent.exists())
        client.login.assert_not_called()
        client.thread.assert_called_once_with('root', '')

    def test_url_decodes_message_and_list_without_losing_plus(self):
        self.assertEqual(archive_link('https://lists.apache.org/thread/%3Cid%2Btag%40example.org%3E'
                                      '?%3Cdev%2Btest.pulsar.apache.org%3E'),
                         ('<id+tag@example.org>', 'dev+test@pulsar.apache.org'))

    def test_url_rejects_other_hosts(self):
        with self.assertRaises(FetchError):
            archive_link('https://example.org/thread/root')

    def test_conflicting_url_list_does_not_access_network(self):
        with patch('fetch_thread.ArchiveClient') as client, patch('sys.stderr', io.StringIO()):
            self.assertEqual(main(['--url', 'https://lists.apache.org/thread/root?<dev.pulsar.apache.org>',
                                   '--list', 'private@pulsar.apache.org', '--context']), 1)
        client.assert_not_called()

    def test_partial_context_does_not_print_a_thread(self):
        client = Mock()
        client.thread.return_value = {'thread': {'mid': 'root'}}
        client.source_by_permalink.return_value = None
        stdout = io.StringIO()
        with patch('fetch_thread.ArchiveClient', return_value=client), \
                patch('sys.stdout', stdout), patch('sys.stderr', io.StringIO()):
            self.assertEqual(main(['--list', 'dev@pulsar.apache.org',
                                   '--message-id', 'root', '--context']), 1)
        self.assertEqual(stdout.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
