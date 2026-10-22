#!/usr/bin/env python3
"""Coordinator-only S09 API drill. Python 3 stdlib + PostgreSQL 17 psql.
Never prints identities, response bodies, display names, backend keys or SQL errors.
This is a workload/evidence driver, not a platform backup implementation.
"""
import argparse
import base64
import datetime
import hashlib
import http.client
import hmac
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit, quote

MIB = 1024 * 1024
SIZE = 4 * MIB


class WalkError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise WalkError(code)


def load(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    # No overwrite: an interrupted run is evidence, not a fresh run.
    with Path(path).open('x', encoding='utf8') as out:
        os.chmod(path, 0o600)
        json.dump(value, out, sort_keys=True)
        out.write('\n')


def block(index):
    # Deterministic, distinct per object; exactly 4 MiB without random state.
    unit = hashlib.sha256(('lifemodel-653.7.4:' + str(index)).encode()).digest()
    return unit * (SIZE // len(unit))


class TLS(http.client.HTTPSConnection):
    def __init__(self, identity):
        self.identity = identity
        url = urlsplit(identity['endpoint'])
        require(url.scheme == 'https' and url.path in ('', '/') and not url.query
                and not url.fragment and not url.username and not url.password,
                'endpoint_invalid')
        context = ssl.create_default_context(cafile=identity['caFile'])
        super().__init__(url.hostname, url.port or 443, timeout=30, context=context)

    def connect(self):
        raw = socket.create_connection(
            (self.identity.get('connectHost', self.host), self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def request(identity, method, path, body=None, headers=None, partial=False):
    token = Path(identity['tokenFile']).read_text().strip()
    require(token and len(token) <= 16384 and all(33 <= ord(c) <= 126 for c in token),
            'identity_invalid')
    conn = TLS(identity)
    try:
        merged = {'authorization': 'Bearer ' + token, **(headers or {})}
        if partial:
            # Advertise 8 MiB, deliver one whole backend chunk, then cut transport.
            # This does not claim that S3 persisted residue; SQL capture proves what exists.
            conn.putrequest(method, path)
            for key, value in merged.items():
                conn.putheader(key, value)
            conn.endheaders()
            conn.send(body)
            conn.sock.shutdown(socket.SHUT_WR)
        else:
            conn.request(method, path, body=body, headers=merged)
        response = conn.getresponse()
        data = response.read(16 * MIB + 1)
        require(len(data) <= 16 * MIB, 'response_too_large')
        return response.status, data, dict(response.getheaders())
    except (OSError, http.client.HTTPException):
        if partial:
            return 0, b'', {}
        raise WalkError('transport_failed') from None
    finally:
        conn.close()


def api(identity, method, path, body=None):
    encoded = None if body is None else json.dumps(body).encode()
    status, data, _ = request(identity, method, path, encoded,
                              {'content-type': 'application/json'})
    require(status in (200, 201), 'api_rejected_' + str(status))
    return json.loads(data)


def task(config, index):
    value = load(config['tasks'][index])
    require(all(c in 'abcdefghijklmnopqrstuvwxyz0123456789_-' for c in value['space'])
            and 1 <= len(value['space']) <= 64, 'space_invalid')
    return value


def core(config, role):
    return load(config[role])


def verify_bytes(identity, space, row):
    status, data, headers = request(identity, 'GET', '/spaces/' + space + '/objects/' + row['id'])
    headers = {key.lower(): value for key, value in headers.items()}
    require(status == 200 and len(data) == row['size']
            and hashlib.sha256(data).hexdigest() == row['sha256']
            and headers.get('x-storage-sha256') == row['sha256']
            and headers.get('x-storage-size') == str(row['size']), 'download_mismatch')
    return len(data)


def deny(identity, space, object_id):
    status, data, _ = request(identity, 'GET', '/spaces/' + space + '/objects/' + object_id)
    require(status in (403, 404), 'denial_missing_' + str(status))
    value = json.loads(data)
    code = value.get('error', {}).get('code')
    require(isinstance(code, str) and len(code) <= 128, 'denial_invalid')
    return {'status': status, 'code': code}


def seed(config, directory):
    identities = [task(config, i) for i in range(2)]
    require(identities[0]['space'] != identities[1]['space'], 'spaces_not_distinct')
    rows = []
    for group, identity in enumerate(identities):
        access = api(identity, 'GET', '/spaces/' + identity['space'] + '/access')
        require(access['mode'] == 'active', 'task_not_active')
        for offset in range(16):
            index = group * 16 + offset
            data = block(index)
            digest = hashlib.sha256(data).hexdigest()
            name = 's09-object-' + str(index).zfill(2)
            upload = 's09-upload-' + str(index).zfill(2)
            headers = {'content-type': 'application/octet-stream',
                       'content-length': str(SIZE), 'x-storage-length': str(SIZE),
                       'x-storage-sha256': digest,
                       'x-storage-name': base64.urlsafe_b64encode(name.encode()).decode().rstrip('=')}
            status, body, _ = request(identity, 'PUT', '/spaces/' + identity['space']
                                      + '/objects/' + upload, data, headers)
            require(status in (200, 201), 'upload_rejected_' + str(status))
            receipt = json.loads(body)
            require(receipt['size'] == SIZE and receipt['sha256'] == digest
                    and receipt['name'] == name and receipt['mark'] is None, 'receipt_mismatch')
            if offset % 2 == 0:
                receipt = api(identity, 'POST', '/spaces/' + identity['space'] + '/objects/'
                              + receipt['id'] + '/mark', {'role': 'result' if offset == 0 else 'artifact'})
            verify_bytes(identity, identity['space'], receipt)
            rows.append({'space': identity['space'], 'group': group, 'uploadId': upload, **receipt})
    # Cross-space denials before sealing/revocation prove actual task isolation.
    cross = [deny(identities[0], identities[1]['space'], rows[16]['id']),
             deny(identities[1], identities[0]['space'], rows[0]['id'])]
    partials = []
    # Both partials belong to the still-open space, so seal does not reclaim them.
    for index in range(2):
        upload = 's09-partial-' + str(index)
        identity = identities[1]
        data = block(32 + index)
        headers = {'content-type': 'application/octet-stream', 'content-length': str(2 * SIZE),
                   'x-storage-length': str(2 * SIZE),
                   'x-storage-sha256': hashlib.sha256(data + data).hexdigest(),
                   'x-storage-name': base64.urlsafe_b64encode(upload.encode()).decode().rstrip('=')}
        status, _, _ = request(identity, 'PUT', '/spaces/' + identity['space'] + '/objects/'
                               + upload, data, headers, partial=True)
        require(status not in (200, 201), 'partial_published')
        partials.append({'space': identity['space'], 'uploadId': upload})
    control = core(config, 'control')
    access = api(identities[0], 'GET', '/spaces/' + identities[0]['space'] + '/access')
    seal_request = {'space': identities[0]['space'], 'effectKey': 's09-seal',
                    'expectedRevision': access['revision'], 'outcome': 'completed'}
    sealed = api(control, 'POST', '/seal', seal_request)
    require(sealed['state'] == 'sealed' and len(sealed['manifest']['objects']) == 8,
            'seal_invalid')
    access = api(identities[1], 'GET', '/spaces/' + identities[1]['space'] + '/access')
    revoke_request = {'space': identities[1]['space'], 'effectKey': 's09-revoke',
                      'expectedRevision': access['revision']}
    revoked = api(control, 'POST', '/revoke', revoke_request)
    save(directory / 'expected.json', {'objects': rows, 'partials': partials, 'cross': cross,
                                      'sealRequest': seal_request, 'seal': sealed,
                                      'revokeRequest': revoke_request, 'revoke': revoked})


def sql_snapshot(config, expected):
    spaces = sorted({row['space'] for row in expected['objects']})
    require(len(spaces) == 2 and all(set(s) <= set('abcdefghijklmnopqrstuvwxyz0123456789_-')
                                   for s in spaces), 'space_invalid')
    scope = "(" + ','.join("'" + s + "'" for s in spaces) + ")"
    tables = ['spaces', 'objects', 'object_versions', 'object_tombstones', 'seal_manifests',
              'seal_receipts', 'revoke_receipts', 'retention_policies']
    expressions = []
    for table in tables:
        if table == 'spaces':
            where = 'id IN ' + scope
        elif table == 'object_versions':
            where = 'object_id IN (SELECT id FROM storage.objects WHERE space_id IN ' + scope + ')'
        else:
            where = 'space_id IN ' + scope
        expressions.append("'" + table + "', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)"
                           ' FROM storage.' + table + ' t WHERE ' + where + "),'[]'::jsonb)")
    expressions += ["'plans', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM storage.deletion_plans t"
                    ' WHERE id IN (SELECT plan_id FROM storage.deletion_candidates WHERE space_id IN '
                    + scope + ")), '[]'::jsonb)",
                    "'candidates', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY object_id) FROM storage.deletion_candidates t"
                    ' WHERE space_id IN ' + scope + "), '[]'::jsonb)"]
    # Separate operational state may change during reconciliation/GC; do not assert equality.
    query = ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT jsonb_build_object('
             + ','.join(expressions) + "); COMMIT;")
    result = subprocess.run(['psql', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
                             '--set=ON_ERROR_STOP=1', '--command', query],
                            capture_output=True, timeout=30, check=False)
    require(result.returncode == 0, 'sql_failed_' + str(result.returncode))
    stable = json.loads(result.stdout)
    require(len(stable['objects']) == 32 and len(stable['object_tombstones']) == 8,
            'catalog_population_mismatch')
    # Assert both interrupted intents exist and neither obtained an immutable version.
    checks = []
    for partial in expected['partials']:
        upload = partial['uploadId']  # Fixed driver-generated identifier, not user SQL.
        require(upload in ('s09-partial-0', 's09-partial-1'), 'partial_id_invalid')
        checks.append("EXISTS(SELECT 1 FROM storage.upload_intents i WHERE i.space_id='" + partial['space']
                      + "' AND i.upload_id='" + upload + "' AND i.state='pending' AND NOT EXISTS"
                      '(SELECT 1 FROM storage.object_versions v WHERE v.object_id=i.object_id))')
    accounting = ('SELECT json_build_object(\'partialUnpublished\', ' + ' AND '.join(checks)
                  + ", 'ledgerValid', (SELECT used_bytes=(SELECT COALESCE(sum(reserved_bytes+charged_bytes),0)"
                  ' FROM storage.space_quota)+(SELECT COALESCE(sum(size),0) FROM storage.orphan_gc WHERE NOT deleted)'
                  ' FROM storage.instance_ledger WHERE id),'
                  " 'orphanDebtBytes',(SELECT COALESCE(sum(size),0) FROM storage.orphan_gc WHERE NOT deleted),"
                  " 'pendingAttempts',(SELECT count(*) FROM storage.upload_attempts a WHERE a.space_id IN "
                  + scope + ' AND NOT EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=a.id)),'
                  " 'unavailable',(SELECT count(*) FROM storage.unavailable_versions));" )
    result = subprocess.run(['psql', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
                             '--set=ON_ERROR_STOP=1', '--command', accounting],
                            capture_output=True, timeout=30, check=False)
    require(result.returncode == 0, 'sql_failed_' + str(result.returncode))
    operational = json.loads(result.stdout)
    require(operational['partialUnpublished'] and operational['ledgerValid']
            and operational['unavailable'] == 0, 'accounting_or_availability_mismatch')
    return stable, operational


def capture(config, directory, phase):
    expected = load(directory / 'expected.json')
    identities = [task(config, i) for i in range(2)]
    reader = core(config, 'read')
    denied = []
    checked = 0
    for row in expected['objects']:
        # Core may retrieve marked retained output even when task identity is revoked.
        if row['mark'] is not None:
            checked += verify_bytes(reader, row['space'], row)
        else:
            denied.append({'id': row['id'], 'kind': 'core_unmarked',
                           **deny(reader, row['space'], row['id'])})
        denied.append({'id': row['id'], 'kind': 'task',
                       **deny(identities[row['group']], row['space'], row['id'])})
    for identity in identities:
        page = api(reader, 'GET', '/spaces/' + identity['space'] + '/objects?limit=100')
        wanted = [{k: row[k] for k in ('id', 'name', 'size', 'sha256', 'mark')}
                  for row in expected['objects'] if row['space'] == identity['space'] and row['mark']]
        require(sorted(page['objects'], key=lambda r: r['id']) == sorted(wanted, key=lambda r: r['id']),
                'marks_or_list_mismatch')
    # Seal is a mutation route and must be replayed only after release, not during hold.
    replay = api(core(config, 'control'), 'POST', '/seal', expected['sealRequest'])
    require(replay == expected['seal'], 'seal_receipt_mismatch')
    replay = api(core(config, 'control'), 'POST', '/revoke', expected['revokeRequest'])
    require(replay == expected['revoke'], 'revoke_receipt_mismatch')
    stable, operational = sql_snapshot(config, expected)
    save(directory / (phase + '.json'), {'stable': stable, 'operational': operational,
                                        'denials': denied, 'checkedBytes': checked,
                                        'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})


def custody(config, directory):
    """Operator-only SigV4 comparison. Never used by task/core API steps."""
    options = load(config['custody'])
    url = urlsplit(options['endpoint'])
    require(url.scheme in ('http', 'https') and url.path in ('', '/') and not url.username
            and not url.password and not url.query and not url.fragment, 'custody_endpoint_invalid')
    # Plain HTTP is only allowed over operator-loopback forwarding.
    require(url.scheme == 'https' or url.hostname in ('127.0.0.1', 'localhost'), 'custody_route_invalid')
    expected = load(directory / 'expected.json')['objects']
    row = next((r for r in expected if r['mark']), None)
    require(row is not None, 'custody_object_invalid')
    object_id = row['id']
    require(len(object_id) == 36 and all(c in '0123456789abcdef-' for c in object_id),
            'custody_object_invalid')
    # Fixed generated UUID only. SQL error/output are private and never printed.
    query = ("SELECT a.s3_key FROM storage.objects o JOIN storage.object_versions v ON v.object_id=o.id "
             "JOIN storage.upload_attempts a ON a.id=v.attempt_id WHERE o.id='" + object_id
             + "'::uuid AND o.mark IS NOT NULL")
    result = subprocess.run(['psql', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
                             '--set=ON_ERROR_STOP=1', '--command', query],
                            capture_output=True, timeout=30, check=False)
    require(result.returncode == 0, 'custody_sql_failed_' + str(result.returncode))
    key = result.stdout.decode().strip()
    require(key and len(key) <= 4096 and all(c.isalnum() or c in '/._-' for c in key), 'custody_key_invalid')
    path = '/lifemodel-storage/' + quote(key, safe='/._-')
    statuses = []
    for field in ('sourceCredentialsFile', 'destinationCredentialsFile'):
        credentials = load(options[field])
        require(set(credentials) == {'accessKey', 'secretKey'}, 'custody_credentials_invalid')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        day = stamp[:8]
        payload = hashlib.sha256(b'').hexdigest()
        headers = {'host': url.netloc, 'x-amz-content-sha256': payload, 'x-amz-date': stamp}
        names = ';'.join(sorted(headers))
        canonical = 'GET\n' + path + '\n\n' + ''.join(k + ':' + headers[k] + '\n' for k in sorted(headers)) + '\n' + names + '\n' + payload
        scope = day + '/us-east-1/s3/aws4_request'
        message = 'AWS4-HMAC-SHA256\n' + stamp + '\n' + scope + '\n' + hashlib.sha256(canonical.encode()).hexdigest()
        def mac(k, v):
            return hmac.new(k, v.encode(), hashlib.sha256).digest()
        signing = mac(mac(mac(mac(('AWS4' + credentials['secretKey']).encode(), day), 'us-east-1'), 's3'), 'aws4_request')
        signature = hmac.new(signing, message.encode(), hashlib.sha256).hexdigest()
        headers['authorization'] = ('AWS4-HMAC-SHA256 Credential=' + credentials['accessKey'] + '/' + scope
                                    + ', SignedHeaders=' + names + ', Signature=' + signature)
        cls = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
        connection = cls(url.hostname, url.port, timeout=30)
        try:
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            data = response.read(SIZE + 1)
            statuses.append(response.status)
            if field == 'sourceCredentialsFile':
                require(response.status == 403, 'source_custody_not_denied')
            else:
                require(response.status == 200 and len(data) == row['size']
                        and hashlib.sha256(data).hexdigest() == row['sha256'], 'destination_custody_mismatch')
        finally:
            connection.close()
    save(directory / 'custody.json', {'sourceStatus': statuses[0], 'destinationStatus': statuses[1], 'hashMatched': True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['seed', 'capture-source', 'capture-restored', 'start-clock', 'custody', 'compare'])
    parser.add_argument('--config', required=True, help='private JSON, see runbook')
    parser.add_argument('--evidence', required=True, help='new/private local directory')
    args = parser.parse_args()
    os.umask(0o077)
    directory = Path(args.evidence)
    directory.mkdir(mode=0o700, parents=False, exist_ok=True)
    require(not directory.is_symlink() and directory.stat().st_mode & 0o777 == 0o700,
            'evidence_permissions_invalid')
    config = load(args.config)
    if args.command == 'seed':
        seed(config, directory)
    elif args.command.startswith('capture-'):
        capture(config, directory, args.command.removeprefix('capture-'))
    elif args.command == 'custody':
        custody(config, directory)
    elif args.command == 'start-clock':
        save(directory / 'restore-clock.json', {'startedUnix': time.time(), 'monotonic': time.monotonic(),
                                               'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()})
    else:
        source, restored = load(directory / 'source.json'), load(directory / 'restored.json')
        require(source['stable'] == restored['stable'], 'catalog_mismatch')
        require(len(source['denials']) == len(restored['denials']), 'denial_count_mismatch')
        identity_changes = 0
        for before, after in zip(source['denials'], restored['denials']):
            require(before['id'] == after['id'] and before['kind'] == after['kind']
                    and before['status'] == after['status'], 'denial_mismatch')
            if before['code'] != after['code']:
                require(before['kind'] == 'task' and after['code'] == 'identity_denied', 'denial_code_mismatch')
                identity_changes += 1
        custody_result = load(directory / 'custody.json')
        require(custody_result == {'sourceStatus': 403, 'destinationStatus': 200, 'hashMatched': True},
                'custody_check_missing')
        require(source['checkedBytes'] == restored['checkedBytes'] == 16 * SIZE, 'checked_bytes_mismatch')
        manifest = load(config['manifest'])
        clock = load(directory / 'restore-clock.json')
        require(clock['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'restore_clock_rebooted')
        cut = datetime.datetime.fromisoformat(manifest['sqlCutAt'].replace('Z', '+00:00')).timestamp()
        result = {'code': 's09_comparison_passed', 'objectsSeeded': 32, 'objectBytesSeeded': 32 * SIZE,
                  'partialUploads': 2, 'tombstones': 8, 'checkedRetainedBytes': 16 * SIZE,
                  'generation': manifest['generation'], 'unavailable': 0,
                  'backupAgeSeconds': round(time.time() - cut, 3),
                  'restoreSeconds': round(time.monotonic() - clock['monotonic'], 3),
                  'orphanDebtBytes': restored['operational']['orphanDebtBytes'],
                  'pendingAttempts': restored['operational']['pendingAttempts'],
                  'freshClusterIdentityDenialChanges': identity_changes}
        save(directory / 'comparison.json', result)
        print(json.dumps(result, sort_keys=True))
    if args.command != 'compare':
        print(json.dumps({'code': 'walk_step_complete', 'step': args.command}))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('{"code":"walk_interrupted"}', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # Unexpected exception messages can carry paths, bodies or connection strings.
        print(json.dumps({'code': str(error) if isinstance(error, WalkError) else 'walk_failed'}), file=sys.stderr)
        sys.exit(1)
