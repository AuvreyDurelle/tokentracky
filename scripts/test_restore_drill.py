import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('restore_drill', Path(__file__).with_name('restore-drill.py'))
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


class DestinationSafety(unittest.TestCase):
    def test_refuses_non_loopback_and_non_drill_destinations(self):
        for value in ['postgres://user@db.example/tokentracky_restore_test',
                      'postgres://user@127.0.0.1/production',
                      'postgres://user@localhost/tokentracky_restore_test',
                      'postgres://user@127.0.0.1/tokentracky_restore_test?host=db.example']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                drill.connection(value, target=True)

    def test_discards_inherited_redirects_and_credential_variables(self):
        with patch.dict(os.environ, {'PGHOSTADDR': '203.0.113.1', 'PGSERVICE': 'prod', 'PGOPTIONS': '-c search_path=public', 'SOURCE_DATABASE_URL': 'private'}):
            env = drill.connection('postgres://user:test%2Fpassword@127.0.0.1:55432/tokentracky_restore_test', target=True)
        self.assertEqual(env['PGHOST'], '127.0.0.1')
        self.assertEqual(env['PGPASSWORD'], 'test/password')
        for key in ('PGHOSTADDR', 'PGSERVICE', 'PGOPTIONS', 'SOURCE_DATABASE_URL'):
            self.assertNotIn(key, env)

    def test_remote_source_requires_certificate_verification(self):
        for query in ('', '?sslmode=require', '?sslmode=disable', '?sslmode=verify-full&host=other.example'):
            with self.subTest(query=query), self.assertRaises(ValueError):
                drill.connection('postgres://user@db.example/source' + query)
        self.assertEqual(drill.connection('postgres://user@db.example/source?sslmode=verify-full')['PGSSLMODE'], 'verify-full')

    def test_existing_target_is_refused_before_dump_or_restore(self):
        with patch.dict(os.environ, {'SOURCE_DATABASE_URL': 'postgres://user@127.0.0.1/source',
                                     'RESTORE_DATABASE_URL': 'postgres://user@127.0.0.1/tokentracky_restore_test'}), \
                patch.object(drill, 'sql', return_value='1'), patch.object(drill, 'command') as command:
            with self.assertRaises(ValueError):
                drill.drill()
            command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
