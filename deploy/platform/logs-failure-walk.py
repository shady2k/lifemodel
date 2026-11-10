#!/usr/bin/env python3
"""WALK-LOGS-FAILURE: a model failure is found by minute and conversation, a
marker in an upstream body reaches no stored log, and the final gateway record's
level is the request's outcome (ADR-016 L03, L04, §9 points 3-6).

What it proves
--------------
1. A model failure planted **through the chat** (the web service's
   `/api/messages`, reached straight on its own 8080 through a port-forward to
   `svc/web` in `lifemodel` with `Origin: https://<web host>` - the path the VM's
   own helper uses, not the forwardAuth ingress) ends in one final gateway
   record, found through the loader's logs API by the failure's minute and its
   conversation: `module=model-gateway`,
   `level=error`, `error_type`, `reason_check`/`reason_path`/`reason_got` where
   the failure has a reason, and the `conversation_id` the chat runs under. The
   same query by that `conversation_id` returns the record, and the core's own
   turn lines carry the same id (ADR-016 §9 point 4). `kubectl` sets the stage -
   the stub, the slots, the gateway's port-forward, the restart - and is never
   the way the record is found.
2. A 32-character random marker in a non-2xx upstream body and another in a
   refused 2xx body, driven through the real core and gateway, with the exchange
   capture off and then on: the capture's own answer is read back after every
   PUT and must say off, then on; a text search for each marker over the whole
   store and over every module finds nothing with the capture off; with it on
   the marker is only in the capture (read through `lifemodel doctor exchange`)
   and never in the store. Each marker is this run's own, so a capture hit
   cannot be an older one. The failure line carries `error_type` and
   `reason_check`/`reason_path`/`reason_got`.
3. The four L04 cases, judged on the final gateway record of each request, sent
   straight to the gateway's own API: primary 500 with no reserve ends `error`;
   primary 400 with a reserve configured ends `error` and the reserve is never
   contacted; primary 500 then a reserve that succeeds gives one `warn`, no
   terminal `error` and a 200 answer; primary 500 then a reserve that fails ends
   `error`. Before each case the walk waits, bounded by --slot-bound, until a
   probe request's stub counts show the gateway serving the new slots - a slot
   write and the next request can race, and the previous configuration served
   one request more on the VM. Every plant must show in the stub's counters
   before anything is judged; without that the case is TEST NOT VALID.
4. The gateway pod is restarted and its new pod's line is in the same query's
   answer: the store holds the previous pod's lines under the same `module`.

The stub, and how the gateway reaches it
----------------------------------------
Both the loader and the model gateway may reach `0.0.0.0/0 except 10.42.0.0/16,
10.43.0.0/16, 169.254.0.0/16` (ADR-013 D5) - owner endpoints on the LAN, no pod
or service address - and the slot check refuses a pod or service URL before it
is stored. The stub therefore runs as a **host-network pod** in the walk's own
namespace: its address is the node's own LAN address, which the deployed policy
already permits, and no policy is loosened. The pod runs the loader image (the
one the gateway runs) with a script from a ConfigMap of the walk's, answers the
slot check and each case's outcome, and serves `/stats` so the walk can count
what really reached it.

Arguments (defaults are the test VM's)
-------------------------------------
  --password-file PATH   the loader's login password, read from this file and
                         never printed (required)
  --loader-host HOST     where the walk connects (default boot-lifemodel.local)
  --loader-port PORT     the loader's TLS port (default 443)
  --origin-host HOST     the host the loader answers on (default
                         boot-lifemodel.local)
  --ca-file PATH         verify the loader's certificate with this CA
  --web-host HOST        the host the chat's Origin names (default
                         lifemodel.local)
  --web-namespace NS     where the web Service lives (default lifemodel)
  --web-service NAME     the web Service the walk forwards to (default web)
  --web-port PORT        the web module's own port (default 8080)
  --slot-bound N         bound on the gateway serving a slot change, proved by a
                         probe request's stub counts (default 120 s)
  --stub-bound N         bound on the stub answering its own counters on the
                         node's LAN address (default 120 s)
  --kubectl COMMAND      default "k3s kubectl"
  --namespace NS         where the gateway and the core live (default
                         lifemodel-system); the chat is reached by its host
                         name, the web ingress's own
  --stub-namespace NS    the walk's own host-network namespace (default
                         lifemodel-model-walk)
  --stub-port PORT       the stub's port on the node (default 18080)
  --node-address ADDRESS the node's LAN address; read from the node object when
                         absent
  --gateway NAME         the gateway Deployment (default model-gateway)
  --gateway-port PORT    the gateway's API port to forward (default 8080)
  --doctor-command CMD   the capture's own reader (default "lifemodel")
  --found-bound N        bound on finding the failure record (default 180 s)
  --chat-bound N         bound on the chat's answer (default 120 s)
  --marker-bound N       bound on a marker search settling (default 120 s)
  --restart-bound N      bound on the gateway's pod being replaced and its line
                         arriving (default 240 s)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
It creates a namespace of its own with a ConfigMap and a host-network pod,
writes the model slots (primary and reserve) to point at the stub, and re-enables
the exchange capture for its own session. The `finally` puts the slots back as
they were read (the stored key and header values are never read or printed; an
omitted field keeps them), turns the capture back to its saved setting, deletes
the stub, its ConfigMap and the namespace it created, and prints a RESTORE line
saying so. The gateway and the core are not restarted for the slots: each slot
read is per request.

A stage that never stands up is not a pass: when the stub does not answer, a
port-forward dies or the loader gives no CSRF token, the walk prints the step and
its own words (the stub's last answer, kubectl's tail) as TEST NOT VALID, and
RESULT counts it, so a run that reached none of its cases exits non-zero.

What it does not cover
----------------------
The chat's own page and the model-status card are other walks' (WALK-LOGS-PAGE).
The capture's retention and its inventory are ADR-013's; this walk only reads
one marker back through the doctor. A failure the core never sends to the
gateway (a local validation error) is not a model failure and is not planted
here.

Exit status is non-zero when any assertion failed or a state was never reached.
"""
import argparse
import http.client
import json
import os
import re
import secrets
import urllib.parse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    Cluster,
    Loader,
    PortForward,
    Report,
    WalkError,
    common_arguments,
    now_ms,
    parse_ms,
    read_password,
    wait_until,
)

GATEWAY_MODULE = 'model-gateway'
CORE_MODULE = 'core'

STUB_SCRIPT = r"""
const http = require('node:http');
const markers = JSON.parse(process.env.WALK_MARKERS || '{}');
const port = Number(process.env.WALK_PORT || 18080);
let checks = 0;
const requests = [];
const counts = {};
const seen = [];
const bodies = new Map();
function completion(model) {
  return JSON.stringify({id: 'walk', object: 'chat.completion',
    choices: [{index: 0, message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}],
    model});
}
function answer(model, body) {
  if (model === 'walk-ok') return [200, completion(model)];
  if (model === 'walk-500') return [500, JSON.stringify({error: {message: 'upstream failed'}})];
  if (model === 'walk-500-marker')
    return [500, JSON.stringify({error: {message: String(markers.non2xx || '')}})];
  if (model === 'walk-400') return [400, JSON.stringify({error: {message: 'bad request'}})];
  if (model === 'walk-bad2xx')
    return [200, JSON.stringify({note: String(markers.refused || ''), choices: 'nope'})];
  if (model === 'walk-bad2xx-refused')
    return [200, JSON.stringify({note: String(markers.refused || '')})];
  return [200, completion(model)];
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET' && req.url === '/stats') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({checks, counts, seen, last: seen.slice(-3)}));
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"ok":true}');
      return;
    }
    let payload = {};
    try { payload = JSON.parse(raw); } catch { payload = {}; }
    const model = String(payload.model || '');
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const first = messages.length > 0 ? String((messages[0] || {}).content || '') : '';
    if (first === 'Reply with OK.' || raw.includes('Reply with OK.')) {
      checks += 1;
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(completion(model));
      return;
    }
    counts[model] = (counts[model] || 0) + 1;
    seen.push(model);
    const [status, body] = answer(model, raw);
    res.writeHead(status, {'content-type': 'application/json'});
    res.end(body);
  });
});
server.listen(port, '0.0.0.0');
"""


def stub_manifest(options, markers):
    """The stub's ConfigMap and host-network pod, both in the walk's namespace."""
    namespace = options.stub_namespace
    config = {
        'apiVersion': 'v1',
        'kind': 'ConfigMap',
        'metadata': {'name': 'walk-model-stub', 'namespace': namespace},
        'data': {'stub.js': STUB_SCRIPT},
    }
    pod = {
        'apiVersion': 'v1',
        'kind': 'Pod',
        'metadata': {'name': 'walk-model-stub', 'namespace': namespace,
                     'labels': {'app.kubernetes.io/name': 'walk-model-stub'}},
        'spec': {
            'hostNetwork': True,
            'dnsPolicy': 'ClusterFirstWithHostNet',
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                                'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{
                'name': 'stub',
                'image': options.stub_image,
                'command': ['node', '/opt/stub/stub.js'],
                'env': [
                    {'name': 'WALK_PORT', 'value': str(options.stub_port)},
                    {'name': 'WALK_MARKERS', 'value': json.dumps(markers)},
                ],
                'securityContext': {'readOnlyRootFilesystem': True,
                                    'allowPrivilegeEscalation': False,
                                    'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '20m', 'memory': '32Mi'},
                              'limits': {'cpu': '200m', 'memory': '64Mi'}},
                'volumeMounts': [{'name': 'stub', 'mountPath': '/opt/stub', 'readOnly': True}],
            }],
            'volumes': [{'name': 'stub',
                         'configMap': {'name': 'walk-model-stub', 'defaultMode': 292}}],
        },
    }
    return [config, pod]


def gateway_image(cluster, options):
    body = cluster.json(['-n', options.namespace, 'get', 'deployment', options.gateway, '-o',
                         'json']) or {}
    containers = ((((body.get('spec') or {}).get('template') or {}).get('spec') or {})
                  .get('containers') or [])
    return containers[0].get('image') if containers else None


def node_address(cluster):
    """The node's own LAN address, which the deployed policy already permits."""
    body = cluster.json(['get', 'nodes', '-o', 'json']) or {}
    for item in body.get('items', []):
        for address in ((item.get('status') or {}).get('addresses') or []):
            if address.get('type') == 'InternalIP' and isinstance(address.get('address'), str):
                return address['address']
    return None


def ensure_stub_namespace(report, cluster, options, state):
    body = cluster.json(['get', 'namespace', options.stub_namespace, '-o', 'json'])
    if body is not None:
        return True
    manifest = {
        'apiVersion': 'v1',
        'kind': 'Namespace',
        'metadata': {'name': options.stub_namespace,
                     'labels': {'pod-security.kubernetes.io/enforce': 'privileged'}},
    }
    if cluster.apply(manifest).returncode != 0:
        report.fail('the walk\'s own host-network namespace exists', options.stub_namespace)
        return False
    state['created_namespace'] = True
    return True


def stub_stats(options):
    """The stub's own counters, read from the host's LAN address."""
    connection = http.client.HTTPConnection(options.node_address, options.stub_port, timeout=10)
    try:
        connection.request('GET', '/stats', headers={'accept': 'application/json'})
        response = connection.getresponse()
        body = response.read(64 * 1024)
        if response.status != 200:
            return None
        value = json.loads(body.decode('utf8', 'replace'))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None
    finally:
        connection.close()


def wait_stub(report, options, bound=None):
    """The stub's own answer on the node's LAN address, within --stub-bound."""
    seconds = options.stub_bound if bound is None else bound
    answer = wait_until(time.monotonic() + seconds, 3, lambda: stub_stats(options))
    return report.check(
        bool(answer), 'the walk\'s stub answers on the node\'s LAN address',
        '%s:%d answered %s within %d s'
        % (options.node_address, options.stub_port,
           'its counters' if answer else 'nothing', seconds))


def gateway_port(options):
    """A port-forward to the gateway's own API, the way the walks reach the store."""
    forward = PortForward(options.kubectl, options.namespace, 'deploy/' + options.gateway,
                          free_port(), options.gateway_port)
    forward.start()
    if not forward.wait_ready(60):
        forward.close(keep_log=True)
        return None, forward
    return forward, forward


def free_port():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def gateway_request(local_port, payload, session, timeout=60):
    """One `/v1/chat/completions` to the gateway: (status, body)."""
    body = json.dumps(payload)
    connection = http.client.HTTPConnection('127.0.0.1', local_port, timeout=timeout)
    try:
        connection.request('POST', '/v1/chat/completions', body.encode(), {
            'content-type': 'application/json',
            'accept': 'application/json',
            'x-lifemodel-session': session,
        })
        response = connection.getresponse()
        data = response.read(256 * 1024)
        return response.status, data.decode('utf8', 'replace')
    except (OSError, http.client.HTTPException):
        return None, ''
    finally:
        connection.close()


def forward_detail(forward):
    """Why a forward never answered, with kubectl's own last lines, never a secret."""
    tail = ' | '.join(forward.log_tail(5)) if forward.log_path is not None else ''
    death = forward.death or 'never ready'
    return death + (('; kubectl: ' + tail) if tail else '')


def renew_gateway_forward(report, options, state, bound=90):
    """A fresh forward after the gateway's pod is replaced: (ok, detail).

    A port-forward is bound to the pod it resolved: the restart kills it.
    """
    old = state.get('forward')
    if old is not None:
        old.close()
    forward = PortForward(options.kubectl, options.namespace, 'deploy/' + options.gateway,
                          free_port(), options.gateway_port)
    forward.start()
    if not forward.wait_ready(bound):
        detail = forward_detail(forward)
        report.fail('the gateway answers a fresh port-forward', detail)
        forward.close(keep_log=True)
        state['forward'] = None
        state['gateway_port'] = None
        return False, detail
    state['forward'] = forward
    state['gateway_port'] = forward.local_port
    return True, 'forward on 127.0.0.1:%d' % forward.local_port


def chat_payload(text, stream=False):
    return {'model': 'default', 'stream': stream,
            'messages': [{'role': 'user', 'content': text}]}


def model_slots(loader):
    """The two slot views as the loader shows them: no key and no header values."""
    answer = loader.json('/api/model')
    return answer if isinstance(answer, dict) else None


def put_slot(loader, token, name, view):
    """Write one slot; an omitted key and header list keep the stored ones."""
    body = {'kind': view.get('kind', 'openai'), 'baseUrl': view['baseUrl'],
            'model': view['model']}
    if view.get('reasoningEffort'):
        body['reasoningEffort'] = view['reasoningEffort']
    status, answer = loader.request(
        'PUT', '/api/model/' + name, json.dumps(body).encode(),
        {'content-type': 'application/json',
         'origin': 'https://' + loader.origin_host,
         'x-csrf-token': token})
    try:
        decoded = json.loads(answer)
    except ValueError:
        decoded = None
    return status, decoded if isinstance(decoded, dict) else {'state': 'unreadable'}


def delete_reserve(loader, token):
    """Clear the reserve slot; the endpoint reads one empty JSON object."""
    status, _answer = loader.request(
        'DELETE', '/api/model/reserve', b'{}',
        {'content-type': 'application/json',
         'origin': 'https://' + loader.origin_host,
         'x-csrf-token': token})
    return status


def capture_setting(loader):
    answer = loader.json('/api/model-capture')
    return answer if isinstance(answer, dict) else None


def put_capture(loader, token, body):
    status, answer = loader.request(
        'PUT', '/api/model-capture', json.dumps(body).encode(),
        {'content-type': 'application/json',
         'origin': 'https://' + loader.origin_host,
         'x-csrf-token': token})
    try:
        decoded = json.loads(answer)
    except ValueError:
        decoded = None
    return status, decoded if isinstance(decoded, dict) else {'state': 'unreadable'}


def capture_off(setting):
    """True when the API's own answer says the capture is off."""
    return isinstance(setting, dict) and setting.get('until') is None \
        and setting.get('mode') != 'until-disabled'


def capture_on(setting):
    return isinstance(setting, dict) and setting.get('until') not in (None, '')


def put_capture_checked(report, loader, token, body, what):
    """PUT the capture setting, then read it back and judge the API's own answer."""
    status, answer = put_capture(loader, token, body)
    read = capture_setting(loader)
    report.check(status == 200 and read is not None,
                 'the capture setting is put (%s)' % what,
                 'PUT answered %d, GET answered %s'
                 % (status, 'yes' if read is not None else 'nothing'))
    return read


def capture_expected(saved, now):
    """What the restored setting should read as: `on` only when it was really on."""
    if not isinstance(saved, dict):
        return 'off'
    if saved.get('mode') == 'until-disabled':
        return 'on'
    until = parse_ms(saved.get('until'))
    return 'on' if until is not None and until > now else 'off'


def capture_restore_body(saved, now):
    """The saved capture setting as a request the API accepts, or None when it expired."""
    if not isinstance(saved, dict):
        return {'durationMs': None}
    if saved.get('mode') == 'until-disabled':
        return {'mode': 'until-disabled',
                **({'session': saved['session']} if saved.get('session') else {})}
    until = parse_ms(saved.get('until'))
    if until is None:
        return {'durationMs': None}
    remaining = until - now
    if remaining <= 0:
        return {'durationMs': None}
    return {'durationMs': remaining,
            **({'session': saved['session']} if saved.get('session') else {})}


def records_in_window(loader, from_ms, to_ms=None, module=None, level=None,
                      conversation=None, text=None, limit=100):
    """One page through the loader's own logs API; None when it did not answer."""
    params = {'from': str(from_ms), 'to': str(to_ms if to_ms is not None else now_ms()),
              'limit': str(limit)}
    if module is not None:
        params['module'] = module
    if level is not None:
        params['level'] = level
    if conversation is not None:
        params['conversation_id'] = conversation
    if text is not None:
        params['text'] = text
    answer = loader.logs(params)
    if answer is None or answer.get('state') != 'ok':
        return None
    return [record for record in (answer.get('records') or []) if isinstance(record, dict)]


def record_count(loader, from_ms, text=None, module=None, conversation=None):
    answer = loader.logs({'from': str(from_ms), 'to': str(now_ms()), 'limit': '1',
                          **({'text': text} if text is not None else {}),
                          **({'module': module} if module is not None else {}),
                          **({'conversation_id': conversation} if conversation else {})})
    if answer is None or answer.get('state') != 'ok':
        return None
    count = answer.get('count')
    return count if isinstance(count, int) else None


def field_of(record, name):
    fields = record.get('fields') or {}
    value = fields.get(name)
    return value if isinstance(value, str) else ''


def failure_verdict(gateway_records, core_records, expected_type):
    """Judge the gateway failure record and the core's own lines (ADR-016 L03)."""
    errors = [record for record in gateway_records if field_of(record, 'level') == 'error']
    if not errors:
        return {'ok': False, 'detail': 'no level=error record in %d gateway line(s)'
                % len(gateway_records), 'record': None}
    record = errors[-1]
    problems = []
    error_type = field_of(record, 'error_type')
    if not error_type:
        problems.append('no error_type')
    elif expected_type and error_type != expected_type:
        problems.append('error_type %s, expected %s' % (error_type, expected_type))
    conversation = field_of(record, 'conversation_id')
    if not conversation:
        problems.append('no conversation_id')
    reason = field_of(record, 'reason_check')
    if reason:
        for name in ('reason_path', 'reason_got'):
            if not field_of(record, name):
                problems.append('reason_check=%s without %s' % (reason, name))
    matching = [line for line in core_records
                if conversation and field_of(line, 'conversation_id') == conversation]
    if not matching:
        problems.append('no core line carries the conversation_id %s' % (conversation or '-'))
    detail = ('module=%s level=error error_type=%s conversation=%s reason=%s; %d core line(s)'
              % (GATEWAY_MODULE, error_type or '-', conversation or '-', reason or 'none',
                 len(matching)))
    if problems:
        detail = '; '.join(problems) + ' (' + detail + ')'
    return {'ok': not problems, 'detail': detail, 'record': record,
            'conversation': conversation}


def marker_verdict(store_counts, capture_hits, marker):
    """Absent from the store with the capture off, only in the capture with it on."""
    problems = []
    if not isinstance(store_counts, dict) or not store_counts:
        problems.append('the store was not searched')
    else:
        found = {name: count for name, count in store_counts.items() if count}
        if found:
            problems.append('%s found in the store: %s' % (marker, ', '.join(
                '%s=%d' % item for item in sorted(found.items()))))
    if not capture_hits:
        problems.append('%s not found in the exchange capture' % marker)
    detail = ('%s: %d module search(es), capture hit(s) %d'
              % (marker, len(store_counts or {}), capture_hits))
    if problems:
        detail = '; '.join(problems) + ' (' + detail + ')'
    return {'ok': not problems, 'detail': detail}


def level_verdict(records, upstream, expected):
    """The final gateway record's level for one request (ADR-016 §9 point 6)."""
    levels = [field_of(record, 'level') for record in records]
    errors = [level for level in levels if level == 'error']
    warns = [level for level in levels if level == 'warn']
    detail = ('%d gateway record(s): %s; upstream %s'
              % (len(records), ', '.join(levels) if levels else 'none',
                 ', '.join('%s=%d' % item for item in sorted(upstream.items())) or 'none'))
    if expected == 'error':
        ok = len(errors) == 1
        if not ok:
            detail = 'expected one final level=error record (' + detail + ')'
    elif expected == 'warn-then-success':
        ok = len(warns) == 1 and not errors
        if not ok:
            detail = ('expected one level=warn and no level=error ('
                      + detail + ')')
    elif expected == 'no-retry':
        ok = len(errors) == 1 and upstream.get('walk-ok', 0) == 0
        if not ok:
            detail = ('expected one level=error and the reserve never contacted ('
                      + detail + ')')
    else:
        ok = False
        detail = 'unknown expectation ' + str(expected)
    return {'ok': ok, 'detail': detail, 'levels': levels}


def marker_verdict(store_counts, capture_hits, marker):
    """Absent from the store with the capture off, only in the capture with it on."""
    problems = []
    if not isinstance(store_counts, dict) or not store_counts:
        problems.append('the store was not searched')
    else:
        found = {name: count for name, count in store_counts.items() if count}
        if found:
            problems.append('%s found in the store: %s' % (marker, ', '.join(
                '%s=%d' % item for item in sorted(found.items()))))
    if not capture_hits:
        problems.append('%s not found in the exchange capture' % marker)
    detail = ('%s: %d module search(es), capture hit(s) %d'
              % (marker, len(store_counts or {}), capture_hits))
    if problems:
        detail = '; '.join(problems) + ' (' + detail + ')'
    return {'ok': not problems, 'detail': detail}


def level_verdict(records, upstream, expected):
    """The final gateway record's level for one request (ADR-016 §9 point 6)."""
    levels = [field_of(record, 'level') for record in records]
    errors = [level for level in levels if level == 'error']
    warns = [level for level in levels if level == 'warn']
    detail = ('%d gateway record(s): %s; upstream %s'
              % (len(records), ', '.join(levels) if levels else 'none',
                 ', '.join('%s=%d' % item for item in sorted(upstream.items())) or 'none'))
    if expected == 'error':
        ok = len(errors) == 1
        if not ok:
            detail = 'expected one final level=error record (' + detail + ')'
    elif expected == 'warn-then-success':
        ok = len(warns) == 1 and not errors
        if not ok:
            detail = ('expected one level=warn and no level=error ('
                      + detail + ')')
    elif expected == 'no-retry':
        ok = len(errors) == 1 and upstream.get('walk-ok', 0) == 0
        if not ok:
            detail = ('expected one level=error and the reserve never contacted ('
                      + detail + ')')
    else:
        ok = False
        detail = 'unknown expectation ' + str(expected)
    return {'ok': ok, 'detail': detail, 'levels': levels}


def exchange_hits(text, marker):
    return len(re.findall(re.escape(marker), text or ''))


def renew_web_forward(report, options, state, bound=90):
    """A port-forward straight to the web Service: the path the VM's own helper uses.

    The `web-private` ingress is behind the loader's forwardAuth, and reaching it
    by its host name needs a session cookie for that host; the web module itself
    accepts the owner's message on its own 8080 and checks the Origin header, so
    the walk forwards to `svc/web` in `lifemodel` and sends
    `Origin: https://<web host>` - the same shape as `/root/lmtest/chat.py`.
    """
    old = state.get('web_forward')
    if old is not None:
        old.close()
    target = 'svc/' + options.web_service
    forward = PortForward(options.kubectl, options.web_namespace, target,
                          free_port(), options.web_port)
    forward.start()
    if not forward.wait_ready(bound):
        detail = forward_detail(forward)
        report.fail('the web service answers a port-forward', detail)
        forward.close(keep_log=True)
        state['web_forward'] = None
        state['web_port'] = None
        return False, detail
    state['web_forward'] = forward
    state['web_port'] = forward.local_port
    return True, 'forward on 127.0.0.1:%d' % forward.local_port


def chat_intake(port, options, text, bound):
    """One owner message through the web service's own `/api/messages`.

    The URL, the status and - on a connection failure - the exception's type are
    returned in the detail; a cookie is never printed.
    """
    body = json.dumps({'id': new_uuid7(), 'text': text}).encode()
    deadline = time.monotonic() + bound
    url = 'POST http://127.0.0.1:%s/api/messages' % port
    error = ''
    while True:
        connection = None
        try:
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
            connection.request('POST', '/api/messages', body, {
                'content-type': 'application/json',
                'origin': 'https://' + options.web_host,
            })
            response = connection.getresponse()
            answer = response.read(64 * 1024)
            status = response.status
        except (OSError, http.client.HTTPException) as failure:
            status, answer = None, b''
            error = type(failure).__name__
        finally:
            if connection is not None:
                connection.close()
        if status == 202:
            try:
                value = json.loads(answer)
            except ValueError:
                value = None
            stream = (value or {}).get('streamId') if isinstance(value, dict) else None
            return True, (stream if isinstance(stream, str) else url)
        if status is not None and status in (400, 403, 409, 429):
            return False, '%s answered %d' % (url, status)
        if time.monotonic() >= deadline:
            return False, '%s did not accept the message (status %s%s)' % (
                url, status, (', last error %s' % error) if error else '')
        time.sleep(3)


def new_uuid7():
    """A v7-shaped id: the intake validates the pattern; the time part is now."""
    import uuid
    value = bytearray(os.urandom(16))
    value[0:6] = (int(time.time() * 1000) & ((1 << 48) - 1)).to_bytes(6, 'big')
    value[6] = (value[6] & 0x0F) | 0x70
    value[8] = (value[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(value)))


def stub_base(options):
    return 'http://%s:%d/v1' % (options.node_address, options.stub_port)


def point_slots(loader, token, options, primary_model, reserve_model):
    """Point the primary (and the reserve, when named) at the stub: (ok, detail)."""
    base = stub_base(options)
    status, answer = put_slot(loader, token, 'primary',
                              {'kind': 'openai', 'baseUrl': base, 'model': primary_model})
    if status != 200:
        return False, 'primary slot write refused: %d %s' % (
            status, answer.get('error', answer.get('state')))
    if reserve_model is None:
        delete_reserve(loader, token)
        return True, 'primary %s, no reserve' % primary_model
    status, answer = put_slot(loader, token, 'reserve',
                              {'kind': 'openai', 'baseUrl': base, 'model': reserve_model})
    if status != 200:
        return False, 'reserve slot write refused: %d %s' % (
            status, answer.get('error', answer.get('state')))
    return True, 'primary %s, reserve %s' % (primary_model, reserve_model)


def upstream_counts(options):
    stats = stub_stats(options) or {}
    counts = stats.get('counts')
    return counts if isinstance(counts, dict) else {}


def upstream_count(options, model):
    return int(upstream_counts(options).get(model, 0))


def wait_planted(report, options, model, before, bound, what):
    """Wait until the stub's count for `model` rises: the plant reached it."""
    reached = wait_until(time.monotonic() + bound, 2,
                         lambda: upstream_count(options, model) > before)
    report.check(bool(reached), 'the plant reached the stub (%s)' % what,
                 'walk model %s: %d -> %d'
                 % (model, before, upstream_count(options, model)))
    if not reached:
        report.not_valid('the %s never reached the stub: its log assertion has no state' % what)
    return bool(reached)


def wait_slots_live(report, options, state, expected, what):
    """Wait until the gateway serves exactly these slots, proved by a probe request.

    The gateway answers with the slots it read for that request; a write to the
    slots and the next request can race, and the previous configuration can serve
    one request more (measured on the VM). The probe is one gateway request with
    its own session, and the stub's counters say which slot models it reached.
    """
    deadline = time.monotonic() + options.slot_bound
    while True:
        before = upstream_counts(options)
        gateway_request(state['gateway_port'], chat_payload('walk slot probe'),
                        'walk-probe-%d' % now_ms())
        after = upstream_counts(options)
        delta = {model: int(after.get(model, 0)) - int(before.get(model, 0))
                 for model in set(before) | set(after)}
        got = {model: count for model, count in delta.items() if count}
        if got == expected:
            report.pass_('the gateway serves the new slots (%s)' % what,
                         ', '.join('%s=%d' % item for item in sorted(got.items())))
            return True
        if time.monotonic() >= deadline:
            report.fail('the gateway serves the new slots (%s)' % what,
                        'the probe reached %s, expected %s within %d s'
                        % (', '.join('%s=%d' % item for item in sorted(got.items())) or 'none',
                           ', '.join('%s=%d' % item for item in sorted(expected.items())),
                           options.slot_bound))
            report.not_valid('the new slots never served: the %s has no state' % what)
            return False
        time.sleep(5)


def wait_record(loader, from_ms, conversation, expected_type, bound, module=GATEWAY_MODULE):
    """Wait until a gateway record with that error_type is in the answer, and return it."""
    def find():
        records = records_in_window(loader, from_ms, module=module, level='error',
                                    conversation=conversation if conversation else None)
        for record in records or []:
            if field_of(record, 'error_type') == expected_type:
                return record
        return None
    return wait_until(time.monotonic() + bound, 3, find)


def case_failure(report, options, loader, token, cluster, state):
    """A chat-driven failure found by minute and conversation, then the restart."""
    ok, detail = point_slots(loader, token, options, 'walk-500', None)
    report.check(ok, 'the primary slot points at the walk\'s stub', detail)
    if not ok:
        return False
    if not wait_slots_live(report, options, state, {'walk-500': 1}, 'the failure case'):
        return False
    before = upstream_count(options, 'walk-500')
    started = now_ms()
    accepted, info = chat_intake(state['web_port'], options,
                                 'walk failure %s' % secrets.token_hex(4), options.chat_bound)
    if not report.check(accepted, 'the chat accepts the owner message', info):
        return False
    if not wait_planted(report, options, 'walk-500', before, options.found_bound,
                        'the chat\'s model call'):
        return False
    record = wait_record(loader, started, None, 'upstream_500', options.found_bound)
    report.check(record is not None,
                 'the gateway writes an error record for the chat\'s failure',
                 'module=%s level=error error_type=upstream_500 within %d s'
                 % (GATEWAY_MODULE, options.found_bound))
    if record is None:
        report.not_valid('no gateway failure record: the minute and conversation cannot be judged')
        return False
    conversation = field_of(record, 'conversation_id')
    in_minute = records_in_window(loader, started, module=GATEWAY_MODULE, level='error') or []
    report.check(any(r.get('time') == record.get('time') for r in in_minute),
                 'the record is found by the failure\'s minute',
                 'time=%s, %d error line(s) in the window'
                 % (record.get('time'), len(in_minute)))
    by_conversation = []
    if conversation:
        by_conversation = records_in_window(loader, started, module=GATEWAY_MODULE,
                                            conversation=conversation) or []
    report.check(any(r.get('time') == record.get('time') for r in by_conversation),
                 'the same record is found by its conversation',
                 'conversation_id=%s, %d line(s)' % (conversation or '-', len(by_conversation)))
    core_records = records_in_window(loader, started, module=CORE_MODULE,
                                     conversation=conversation) if conversation else None
    verdict = failure_verdict([record], core_records or [], 'upstream_500')
    report.check(verdict['ok'],
                 'the failure reads as field and type, under the chat\'s conversation',
                 verdict['detail'])
    return failure_restart(report, options, loader, token, cluster, state, started)


def failure_restart(report, options, loader, token, cluster, state, started_ms):
    """Restart the gateway; its new pod's line is in the same query's answer."""
    pods = cluster.pods(options.namespace, 'app.kubernetes.io/name=' + options.gateway)
    before = ((pods[0].get('metadata') or {}).get('name') if pods else None)
    if before is None:
        report.not_valid('the gateway has no pod to restart')
        return False
    killed = cluster.run(['-n', options.namespace, 'delete', 'pod', before,
                          '--ignore-not-found', '--wait=false']).returncode == 0
    report.check(killed, 'the gateway pod is restarted', before)
    if not killed:
        return False
    deadline = time.monotonic() + options.restart_bound

    def renewed():
        for pod in cluster.pods(options.namespace, 'app.kubernetes.io/name=' + options.gateway):
            name = (pod.get('metadata') or {}).get('name')
            if name and name != before and cluster.is_ready(options.namespace, name):
                return name
        return None

    pod = wait_until(deadline, 5, renewed)
    report.check(pod is not None, 'a new gateway pod is ready',
                 '%s replaced within %d s' % (before, options.restart_bound))
    if pod is None:
        return False
    if not renew_gateway_forward(report, options, state):
        return False
    # One request makes the new pod log; the same query then holds both pods' lines.
    session = 'walk-failure-after-%d' % now_ms()
    gateway_request(state['gateway_port'], chat_payload('walk failure after the restart'),
                    session)

    def both_pods():
        records = records_in_window(loader, started_ms, module=GATEWAY_MODULE) or []
        seen = {field_of(record, 'pod') for record in records}
        seen.discard('')
        return seen if len(seen) >= 2 else None

    seen = wait_until(deadline, 5, both_pods)
    report.check(seen is not None,
                 'the same query answers with the new pod\'s line beside the old one',
                 'pods %s' % (', '.join(sorted(seen)) if seen else 'only ' + before))
    return seen is not None


def exchange_text(options, bound):
    """The capture's own reader, `lifemodel doctor exchange last N`."""
    deadline = time.monotonic() + bound
    while True:
        try:
            import subprocess
            result = subprocess.run(
                [*options.doctor_command.split(), 'doctor', 'exchange', 'last', '20'],
                capture_output=True, text=True, timeout=90)
            if result.returncode == 0 and result.stdout:
                return result.stdout
        except (OSError, subprocess.SubprocessError):
            pass
        if time.monotonic() >= deadline:
            return ''
        time.sleep(5)


def store_counts_for(loader, markers, from_ms):
    """How many records each marker has, over all modules and over each module."""
    modules_answer = loader.json('/api/logs/modules')
    modules = (modules_answer or {}).get('modules') if isinstance(modules_answer, dict) else []
    modules = [name for name in (modules or []) if isinstance(name, str)]
    counts = {}
    for marker in markers:
        counts['all:' + marker] = record_count(loader, from_ms, text=marker) or 0
        for name in modules:
            counts[name + ':' + marker] = record_count(
                loader, from_ms, text=marker, module=name) or 0
    return counts


def case_marker(report, options, loader, token, cluster, state):
    """The L03 markers: absent with the capture off, only in the capture with it on."""
    marker_a = options.markers['non2xx']
    marker_b = options.markers['refused']
    markers = [marker_a, marker_b]
    saved = capture_setting(loader)
    state['capture_saved'] = saved
    read = put_capture_checked(report, loader, token, {'durationMs': None}, 'off')
    if not report.check(capture_off(read),
                        'the exchange capture reads back as off before the marker is planted',
                        'GET /api/model-capture: %s'
                        % (json.dumps(read) if read is not None else 'no answer')):
        report.not_valid('the capture cannot be turned off: a marker could only be in the capture')
        return False
    planted = []
    for label, model, expected in (('a non-2xx body', 'walk-500-marker', 'upstream_500'),
                                   ('a refused 2xx body', 'walk-bad2xx', 'bad_response')):
        ok, detail = point_slots(loader, token, options, model, None)
        report.check(ok, 'the primary slot answers with %s' % label, detail)
        if not ok:
            return False
        if not wait_slots_live(report, options, state, {model: 1}, 'the marker case'):
            continue
        before = upstream_count(options, model)
        started = now_ms()
        accepted, info = chat_intake(state['web_port'], options,
                                     'walk marker %s' % secrets.token_hex(4),
                                     options.chat_bound)
        if not report.check(accepted, 'the chat accepts the marker message (%s)' % label, info):
            continue
        if not wait_planted(report, options, model, before, options.found_bound, label):
            continue
        record = wait_record(loader, started, None, expected, options.found_bound)
        report.check(record is not None,
                     'the gateway records the failure of %s' % label,
                     'error_type=%s within %d s' % (expected, options.found_bound))
        if record is not None:
            planted.append((label, record, started))
    off_counts = store_counts_for(loader, markers, now_ms() - 3600_000)
    for marker in markers:
        found = sum(count for name, count in off_counts.items() if name.endswith(':' + marker))
        report.check(found == 0,
                     'with the capture off, %s is in no stored log' % marker,
                     '%d record(s) in %d search(es)' % (found, len(off_counts)))
    reason = next((record for label, record, _started in planted if label.startswith('a refused')),
                  None)
    if reason is not None:
        report.check(field_of(reason, 'reason_check') != '',
                     'the refused 2xx failure carries reason_check/path/got',
                     'reason_check=%s path=%s got=%s'
                     % (field_of(reason, 'reason_check') or '-',
                        field_of(reason, 'reason_path') or '-',
                        field_of(reason, 'reason_got') or '-'))
    # Capture on: plant both again, then the markers are only in the capture.
    read = put_capture_checked(report, loader, token, {'durationMs': 15 * 60_000}, 'on')
    if not report.check(capture_on(read), 'the exchange capture reads back as on',
                        'GET /api/model-capture: %s'
                        % (json.dumps(read) if read is not None else 'no answer')):
        report.not_valid('the capture cannot be turned on: the marker cannot be read back')
        return False
    on_started = now_ms()
    on_planted = 0
    for label, model, expected in (('a non-2xx body', 'walk-500-marker', 'upstream_500'),
                                   ('a refused 2xx body', 'walk-bad2xx', 'bad_response')):
        ok, _detail = point_slots(loader, token, options, model, None)
        if not ok:
            continue
        if not wait_slots_live(report, options, state, {model: 1}, 'the marker case again'):
            continue
        before = upstream_count(options, model)
        chat_intake(state['web_port'], options, 'walk marker %s' % secrets.token_hex(4),
                    options.chat_bound)
        if not wait_planted(report, options, model, before, options.found_bound,
                            label + ' with the capture on'):
            continue
        if wait_record(loader, on_started, None, expected, options.found_bound) is not None:
            on_planted += 1
    if on_planted < 2:
        report.not_valid('the second plant did not reach the store for both markers: the '
                         'capture cannot be read back for them')
        return False
    text = exchange_text(options, options.marker_bound)
    hits = [exchange_hits(text, marker) for marker in markers]
    on_counts = store_counts_for(loader, markers, on_started)
    for marker, hit in zip(markers, hits):
        report.check(hit > 0, 'with the capture on, %s is in the capture' % marker,
                     '%d hit(s) in the reader\'s answer; the marker is this run\'s own'
                     % hit)
        verdict = marker_verdict({'all:' + marker: sum(
            count for name, count in on_counts.items() if name.endswith(':' + marker))},
            hit, marker)
        report.check(verdict['ok'], 'with the capture on, %s is only in the capture' % marker,
                     verdict['detail'])
    return True


def case_levels(report, options, loader, token, state):
    """The four L04 cases, judged on each request's final gateway record."""
    cases = [
        ('primary 500 with no reserve ends error', 'walk-500', None, 'error', 'error',
         {'walk-500': 1}),
        ('primary 400 with a reserve ends error and never retries', 'walk-400', 'walk-ok',
         'no-retry', 'error', {'walk-400': 1}),
        ('primary 500 then a reserve that succeeds gives one warn', 'walk-500', 'walk-ok',
         'warn-then-success', 'ok', {'walk-500': 1, 'walk-ok': 1}),
        ('primary 500 then a reserve that fails ends error', 'walk-500', 'walk-500', 'error',
         'error', {'walk-500': 2}),
    ]
    for name, primary, reserve, expected, outcome, live in cases:
        ok, detail = point_slots(loader, token, options, primary, reserve)
        if not report.check(ok, 'the slots are set for: ' + name, detail):
            continue
        if not wait_slots_live(report, options, state, live, name):
            continue
        before = upstream_counts(options)
        session = 'walk-level-%d-%d' % (now_ms(), len(state['level_sessions']))
        status, answer = gateway_request(state['gateway_port'],
                                         chat_payload('walk level case'), session)
        report.check((status is not None and 200 <= status < 300) if outcome == 'ok'
                     else (status is not None and status >= 400),
                     'the gateway answers %s with %s' % (name, 'a model answer' if outcome == 'ok'
                                                        else 'an error'),
                     'status %s' % status)
        if status is None:
            report.not_valid('the gateway did not answer: the final record has no state')
            continue
        after = upstream_counts(options)
        delta = {model: int(after.get(model, 0)) - int(before.get(model, 0))
                 for model in set(before) | set(after)}
        reached = {model: count for model, count in delta.items() if count}
        if reached != live:
            report.not_valid('the request did not reach the slots it was meant to (reached %s): '
                             'the level has no state'
                             % (', '.join('%s=%d' % item for item in sorted(reached.items()))
                                or 'none'))
            continue
        deadline = time.monotonic() + options.found_bound
        records = wait_until(deadline, 3, lambda: records_in_window(
            loader, now_ms() - 3600_000, module=GATEWAY_MODULE, conversation=session)
            or None) or []
        verdict = level_verdict(records, delta, expected)
        report.check(verdict['ok'], name, verdict['detail'])
        state['level_sessions'].append(session)
    return True


def slot_fingerprint(view):
    """What a slot can be compared by without reading a key or a header value."""
    if not isinstance(view, dict):
        return None
    try:
        host = urllib.parse.urlsplit(view.get('baseUrl') or '').hostname
    except ValueError:
        host = None
    return {'kind': view.get('kind'), 'model': view.get('model'), 'host': host,
            'keySet': bool(view.get('keySet'))}


def slots_agree(saved, current):
    """The parts of the two slot views that differ, by name."""
    problems = []
    for name in ('primary', 'reserve'):
        before = slot_fingerprint(saved.get(name))
        after = slot_fingerprint(current.get(name))
        if before == after:
            continue
        problems.append('%s %s -> %s' % (name, json.dumps(before), json.dumps(after)))
    return problems


def restore(report, options, loader, token, cluster, state):
    """Put the slots, the capture and the stub back, and say what was done."""
    restored = True
    saved = state.get('slots')
    if saved is not None and loader is not None and token is not None:
        for name in ('primary', 'reserve'):
            view = saved.get(name)
            if view is None:
                if name == 'reserve' and state.get('hadReserve') is False and \
                        delete_reserve(loader, token) != 200:
                    restored = False
                continue
            status, answer = put_slot(loader, token, name, view)
            if status != 200:
                restored = False
                print('RESTORE incomplete: slot %s could not be written back (%d %s)'
                      % (name, status, answer.get('error', answer.get('state'))))
    if saved is not None and loader is not None and token is not None:
        current = model_slots(loader) or {}
        problems = slots_agree({'primary': saved.get('primary'), 'reserve': saved.get('reserve')},
                               {'primary': current.get('primary'),
                                'reserve': current.get('reserve')})
        if problems:
            restored = False
            print('RESTORE incomplete: the slots read back differ (%s)' % '; '.join(problems))
        else:
            print('RESTORE slots read back as saved: primary %s, reserve %s'
                  % ('set' if saved.get('primary') else 'absent',
                     'set' if saved.get('reserve') else 'absent'))
    capture_saved = state.get('capture_saved')
    if capture_saved is not None and loader is not None and token is not None:
        body = capture_restore_body(capture_saved, now_ms())
        status, answer = put_capture(loader, token, body)
        current = capture_setting(loader)
        wanted = capture_expected(capture_saved, now_ms())
        agreed = (capture_off(current) if wanted == 'off' else capture_on(current))
        if status != 200 or not agreed:
            restored = False
            print('RESTORE incomplete: the capture setting is %s, wanted %s (PUT %d, read %s)'
                  % (json.dumps(current) if current is not None else 'unreadable', wanted,
                     status, 'answered' if current is not None else 'unreadable'))
        else:
            print('RESTORE capture reads back as %s' % wanted)
    if state.get('created_namespace'):
        if cluster.run(['delete', 'namespace', options.stub_namespace,
                        '--wait=false']).returncode != 0:
            restored = False
    print('RESTORE slots as they were read (a key and header values were never read or '
          'printed), capture back to its saved setting, stub namespace deleted=%s, gateway '
          'left running' % str(bool(state.get('created_namespace'))).lower())
    if not restored:
        print('RESTORE incomplete: check the model slots and the capture setting by hand')


def stopped(report, step, detail):
    """An early exit says why, and counts as a state the walk never reached."""
    report.not_valid('the walk did not reach its cases: %s - %s' % (step, detail))
    return False


def run(report, options, loader, cluster, state):
    """The three cases, with the stub and the port-forward as the stage."""
    if not wait_stub(report, options):
        return stopped(report, 'the stub never answered',
                       '%s:%d within %d s' % (options.node_address, options.stub_port,
                                              options.stub_bound))
    try:
        ok, detail = renew_gateway_forward(report, options, state)
        if not ok:
            return stopped(report, 'the gateway\'s port-forward failed', detail)
        ok, detail = renew_web_forward(report, options, state)
        if not ok:
            return stopped(report, 'the web service\'s port-forward failed', detail)
        token = loader.csrf()
        if not report.check(bool(token), 'the loader answers a CSRF token', 'GET /api/state'):
            return stopped(report, 'the loader answered no CSRF token', 'GET /api/state')
        state['token'] = token
        saved = model_slots(loader) or {}
        state['slots'] = {'primary': saved.get('primary'), 'reserve': saved.get('reserve')}
        state['hadReserve'] = saved.get('reserve') is not None
        report.note('the slots are saved for restore: primary %s, reserve %s'
                    % ('set' if saved.get('primary') else 'absent',
                       'set' if saved.get('reserve') else 'absent'))
        failure = case_failure(report, options, loader, token, cluster, state)
        marker = case_marker(report, options, loader, token, cluster, state) \
            if failure else False
        levels = case_levels(report, options, loader, token, state) if marker else False
        return bool(failure and marker and levels)
    finally:
        for name in ('forward', 'web_forward'):
            if state.get(name) is not None:
                state[name].close()
                state[name] = None


def exit_code(report, ran):
    """RESULT and the exit status count a run that stopped before its cases."""
    if ran is not True and report.failures == 0 and report.invalid == 0:
        report.not_valid('the walk reached none of its cases')
    return report.result()


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-FAILURE (ADR-016 L03, L04)')
    common_arguments(parser)
    parser.add_argument('--web-host', default='lifemodel.local')
    parser.add_argument('--web-namespace', default='lifemodel')
    parser.add_argument('--web-service', default='web')
    parser.add_argument('--web-port', type=int, default=8080)
    parser.add_argument('--slot-bound', type=int, default=120)
    parser.add_argument('--stub-bound', type=int, default=120)
    parser.add_argument('--stub-namespace', default='lifemodel-model-walk')
    parser.add_argument('--stub-port', type=int, default=18080)
    parser.add_argument('--node-address')
    parser.add_argument('--gateway', default='model-gateway')
    parser.add_argument('--gateway-port', type=int, default=8080)
    parser.add_argument('--doctor-command', default='lifemodel')
    parser.add_argument('--found-bound', type=int, default=180)
    parser.add_argument('--chat-bound', type=int, default=120)
    parser.add_argument('--marker-bound', type=int, default=120)
    parser.add_argument('--restart-bound', type=int, default=240)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    state = {'created_namespace': False, 'gateway_port': None, 'forward': None,
             'web_port': None, 'web_forward': None, 'slots': None, 'level_sessions': []}
    loader = None
    ran = False

    def stage():
        """The stage and the three cases; False when it stopped early, with its reason."""
        nonlocal loader
        try:
            secret = read_password(options.password_file)
        except WalkError as error:
            print('FAIL the credential file is readable - ' + str(error))
            return False
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        status = loader.login(secret)
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return False
        address = options.node_address or node_address(cluster)
        if not report.check(bool(address), 'the node has a LAN address', address or 'none'):
            return False
        options.node_address = address
        image = gateway_image(cluster, options)
        if not report.check(bool(image), 'the gateway names its image', options.gateway):
            return False
        options.stub_image = image
        markers = {'non2xx': 'walk-marker-' + secrets.token_hex(16),
                   'refused': 'walk-marker-' + secrets.token_hex(16)}
        options.markers = markers
        if not ensure_stub_namespace(report, cluster, options, state):
            return False
        for manifest in stub_manifest(options, markers):
            if cluster.apply(manifest).returncode != 0:
                report.fail('the stub is created', manifest['kind'])
                return False
        return run(report, options, loader, cluster, state)

    try:
        ran = stage()
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        token = state.get('token')
        restore(report, options, loader, token, cluster, state)
    return exit_code(report, ran)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
