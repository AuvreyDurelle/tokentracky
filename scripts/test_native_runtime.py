"""Safety/acceptance tests; no macOS UI, credential, or user data access."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import urllib.request

spec = importlib.util.spec_from_file_location('native_runtime', Path(__file__).with_name('native_runtime.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class RuntimeTests(unittest.TestCase):
    def complete(self):
        return {'elapsed_seconds': 86400, 'max_sample_gap_seconds': 90,
                'manual_events': ['offline-start', 'offline-end', 'short-wake', 'long-wake',
                                  'repeated-wake', 'offline-wake', 'wake-during-sync'],
                'collection_ok': True, 'sync_ok': True, 'closed_budget_ok': True,
                'no_growth': True, 'graceful_exit': True, 'signed_notarized_candidate': True,
                'wake_notifications': 5, 'artifact_unchanged': True}

    def test_short_unsigned_or_interrupted_soak_cannot_pass(self):
        good = self.complete()
        self.assertEqual(native.validate_soak(good, 86400, 900), [])
        for patch in ({'elapsed_seconds': 86399}, {'signed_notarized_candidate': False},
                      {'manual_events': []}, {'max_sample_gap_seconds': 901},
                      {'artifact_unchanged': False}, {'graceful_exit': False},
                      {'sync_ok': False}, {'wake_notifications': 0}):
            with self.subTest(patch=patch):
                self.assertTrue(native.validate_soak(dict(good, **patch), 86400, 900))

    def test_fixture_counts_and_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'sources'
            expected = native.fixture(source)
            records = [json.loads(line) for p in source.glob('*.jsonl') for line in p.read_text().splitlines()]
            self.assertEqual((len(records), len({r['sessionId'] for r in records})), (600, 60))
            self.assertEqual(expected['tokens'], 2760000)
            self.assertEqual(len({r['requestId'] for r in records}), 600)
            self.assertEqual(len({r['timestamp'][:10] for r in records}), 30)
            self.assertTrue(all(r['cwd'].startswith('/synthetic/') for r in records))

    def test_closed_soak_budget_includes_samples_between_hourly_visits(self):
        samples = [{'label': f'you-{i}-closed-10s', 'mb': 26} for i in range(4)]
        samples.append({'label': 'soak-61', 'mb': 41})
        samples.extend({'label': f'leaderboard-{i}-closed-10s', 'mb': 26} for i in range(4))
        assessment = native.assess_closed_memory(samples)
        self.assertFalse(assessment['closed_budget_ok'])
        self.assertTrue(assessment['no_growth'])
        samples[4]['mb'] = 40
        self.assertTrue(native.assess_closed_memory(samples)['closed_budget_ok'])
        self.assertFalse(native.assess_closed_memory([])['closed_budget_ok'])

    def test_hourly_soak_usage_has_new_identities_and_explicit_expected_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = object.__new__(native.Runtime)
            runtime.raw = Path(directory)
            (runtime.raw / 'sources').mkdir()
            runtime.added_events = 0
            runtime.event = lambda *_args, **_kwargs: None
            runtime.append_soak_usage()
            runtime.append_soak_usage()
            records = [json.loads(line) for line in (runtime.raw / 'sources/native-soak.jsonl').read_text().splitlines()]
            self.assertEqual(len({r['requestId'] for r in records}), 2)
            self.assertEqual(runtime.expected_totals(), {'events': 602, 'tokens': 2769200})

    def test_loopback_fixture_sink_is_idempotent_and_rejects_conflicting_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            cloud = native.FixtureCloud(Path(directory), 'runtime-test')
            try:
                body = {'checkpoint': 1, 'buckets': [{'day': '2026-10-24', 'tool': 'claude',
                                                     'model': 'synthetic', 'tokens': 123, 'revision': 1}]}
                def upload():
                    request = urllib.request.Request(cloud.origin+'/api/ingest', data=json.dumps(body).encode(),
                        headers={'Authorization': 'Bearer synthetic-native-runtime-runtime-test-app',
                                 'Content-Type': 'application/json'})
                    return urllib.request.urlopen(request, timeout=2)
                for _ in range(2):
                    with upload() as response:
                        self.assertEqual(response.status, 200)
                self.assertEqual(cloud.summary()['tokens'], 123)
                body['buckets'][0]['tokens'] = 124
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    upload()
                self.assertEqual(raised.exception.code, 409)
                raised.exception.close()
                cloud.offline = True
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    upload()
                self.assertEqual(raised.exception.code, 503)
                raised.exception.close()
            finally:
                cloud.close()


if __name__ == '__main__':
    unittest.main()
