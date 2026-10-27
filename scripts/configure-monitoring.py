#!/usr/bin/env python3
"""Idempotently configure public uptime checks and optional notification-backed alerts.

Prints the proposed configuration unless --apply is supplied. Uses the current
gcloud identity without printing its token. Does not create an email channel or
send test notifications; pass an existing verified --channel resource name.
"""
import argparse
import json
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request


def configurations(project):
    return [{
        # GCP uptime hosts are immutable: a domain cutover needs distinct checks.
        'displayName': 'Tokentracky ' + name + ' (tokentracky.com)',
        'monitoredResource': {'type': 'uptime_url', 'labels': {'project_id': project, 'host': 'tokentracky.com'}},
        'httpCheck': {'requestMethod': 'GET', 'useSsl': True, 'path': path, 'port': 443, 'validateSsl': True,
                      'acceptedResponseStatusCodes': [{'statusValue': 200}]},
        'period': '300s', 'timeout': '10s', 'selectedRegions': ['EUROPE', 'USA', 'ASIA_PACIFIC'],
        'contentMatchers': [{'content': content, 'matcher': 'CONTAINS_STRING'}],
    } for name, path, content in [('public API health', '/api/health', '"mode":"hosted"'),
                                 ('public leaderboard', '/api/leaderboard?period=all&pageSize=1', '"items"')]]


def policy(check, channel):
    check_id = check['name'].rsplit('/', 1)[1]
    return {'displayName': check['displayName'] + ' unavailable', 'enabled': True, 'combiner': 'OR',
            'notificationChannels': [channel],
            'documentation': {'mimeType': 'text/markdown', 'content': 'Public Vercel route is failing from multiple regions. Run scripts/check-hosted.mjs, check Cloud Run revision health and database access, and follow your private incident runbook. Do not collect request bodies or credentials.'},
            'conditions': [{'displayName': 'Two or more regions failing for five minutes', 'conditionThreshold': {
                'filter': 'metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id="' + check_id + '"',
                'comparison': 'COMPARISON_GT', 'thresholdValue': 1, 'duration': '300s',
                'aggregations': [{'alignmentPeriod': '120s', 'perSeriesAligner': 'ALIGN_NEXT_OLDER', 'crossSeriesReducer': 'REDUCE_COUNT_FALSE'}],
            }}]}


def service_policies(channel=None):
    """Initial operational thresholds; review against measured launch traffic before applying."""
    scope = 'resource.type="cloud_run_revision" AND resource.label.service_name="tokentracky-api" AND resource.label.location="europe-west2"'
    specs = [
        ('API server errors', 'run.googleapis.com/request_count', ' AND metric.label.response_code_class="5xx"', 'ALIGN_DELTA', 'REDUCE_SUM', 5),
        ('API rate-limit rejections', 'run.googleapis.com/request_count', ' AND metric.label.response_code="429"', 'ALIGN_DELTA', 'REDUCE_SUM', 20),
        ('API p95 latency', 'run.googleapis.com/request_latencies', '', 'ALIGN_PERCENTILE_95', 'REDUCE_MAX', 2000),
    ]
    return [{
        'displayName': 'Tokentracky ' + name, 'enabled': True, 'combiner': 'OR',
        'notificationChannels': [channel] if channel else [],
        'documentation': {'mimeType': 'text/markdown', 'content': 'Check Cloud Run revision health, database saturation, gateway identity and quota behavior. Use aggregate metrics only; never enable request-body or credential logging. Follow your private incident runbook.'},
        'conditions': [{'displayName': name + ' sustained for five minutes', 'conditionThreshold': {
            'filter': 'metric.type="' + metric + '" AND ' + scope + extra,
            'comparison': 'COMPARISON_GT', 'thresholdValue': threshold, 'duration': '300s',
            'aggregations': [{'alignmentPeriod': '60s', 'perSeriesAligner': align, 'crossSeriesReducer': reduce}],
        }}],
    } for name, metric, extra, align, reduce, threshold in specs]


def moderation_policy(channel=None):
    """Upload checks log structured lines with counts and reasons only, never an alias."""
    return {'displayName': 'Tokentracky moderation flags', 'enabled': True, 'combiner': 'OR',
            'notificationChannels': [channel] if channel else [],
            'documentation': {'mimeType': 'text/markdown', 'content': 'An upload was flagged, or the moderation breaker turned hides into reviews (likely a parser release inflating many members). Run `npx tsx scripts/moderation.ts queue` and follow your private moderation runbook. Run `audit` against the configured review deadline. Never paste aliases into public channels.'},
            'conditions': [{'displayName': 'Moderation flag or breaker logged', 'conditionMatchedLog': {
                'filter': 'resource.type="cloud_run_revision" AND resource.labels.service_name="tokentracky-api" AND jsonPayload.event=("moderation_flag" OR "moderation_breaker")',
            }}],
            # Log-match conditions require a rate limit; a burst of flags notifies once per five minutes.
            'alertStrategy': {'notificationRateLimit': {'period': '300s'}, 'autoClose': '1800s'}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default='tokentracky')
    parser.add_argument('--channel')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,62}', args.project):
        parser.error('Invalid project identifier')
    if args.channel and not re.fullmatch(r'projects/' + re.escape(args.project) + r'/notificationChannels/[0-9]+', args.channel):
        parser.error('Channel must belong to the selected project')
    proposed = configurations(args.project)
    if not args.apply:
        print(json.dumps({'uptimeChecks': proposed, 'serviceAlertPolicies': [*service_policies(args.channel), moderation_policy(args.channel)], 'notificationChannel': args.channel, 'apply': False}, indent=2))
        return
    token = subprocess.run(['gcloud', 'auth', 'print-access-token'], capture_output=True, text=True, check=True).stdout.strip()
    base = 'https://monitoring.googleapis.com/v3/'

    def api(path, method='GET', value=None):
        request = urllib.request.Request(base + path, method=method,
                                         headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                                         data=json.dumps(value).encode() if value is not None else None)
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def all_items(collection):
        path = 'projects/' + args.project + '/' + collection
        items = []
        while True:
            result = api(path)
            items.extend(result.get(collection, []))
            if not result.get('nextPageToken'):
                return items
            path = 'projects/' + args.project + '/' + collection + '?pageToken=' + urllib.parse.quote(result['nextPageToken'])

    if args.channel:
        channel = api(args.channel)
        if channel.get('verificationStatus') != 'VERIFIED' or channel.get('enabled') is False:
            raise ValueError('Notification channel must be enabled and verified')
    existing = all_items('uptimeCheckConfigs')
    applied = []
    for check in proposed:
        matches = [entry for entry in existing if entry.get('displayName') == check['displayName']]
        if len(matches) > 1:
            raise ValueError('Duplicate uptime display names; resolve manually')
        if matches:
            result = api(matches[0]['name'], 'PATCH', {**check, 'name': matches[0]['name']})
        else:
            result = api('projects/' + args.project + '/uptimeCheckConfigs', 'POST', check)
        applied.append(result)
    alerts = []
    if args.channel:
        existing_policies = all_items('alertPolicies')
        for desired in [*(policy(check, args.channel) for check in applied), *service_policies(args.channel), moderation_policy(args.channel)]:
            matches = [entry for entry in existing_policies if entry.get('displayName') == desired['displayName']]
            if len(matches) > 1:
                raise ValueError('Duplicate alert display names; resolve manually')
            result = api(matches[0]['name'], 'PATCH', {**desired, 'name': matches[0]['name']}) if matches else api('projects/' + args.project + '/alertPolicies', 'POST', desired)
            alerts.append(result['name'])
    print(json.dumps({'uptimeChecks': [check['name'] for check in applied], 'alertPolicies': alerts,
                      'alertDeliveryVerified': False, 'missing': [] if args.channel else ['Verified notification channel; alerts not configured']}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, subprocess.CalledProcessError, ValueError) as error:
        # Do not echo raw API requests, account identifiers or auth errors.
        print(json.dumps({'passed': False, 'errorType': type(error).__name__, 'message': 'Monitoring setup failed; inspect project access and proposed configuration.'}))
        raise SystemExit(1)
