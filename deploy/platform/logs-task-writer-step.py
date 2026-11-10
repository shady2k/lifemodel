#!/usr/bin/env python3
"""Start one core-owned task writer for the browser walk; never print its reply."""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    Cluster, Loader, Report, WalkError, common_arguments, read_password, start_task_writer,
)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    common_arguments(parser)
    parser.add_argument('--web-namespace', default='lifemodel')
    parser.add_argument('--web-service', '--web-deployment', dest='web_service', default='web')
    parser.add_argument('--web-port', type=int, default=8080)
    parser.add_argument('--web-host', default='lifemodel.local')
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--rate', type=int, default=5)
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--bound', type=int, default=180)
    options = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', options.run_id):
        parser.error('--run-id must be 1-100 ASCII letters, digits, underscores or hyphens')
    if not (1 <= options.rate <= 2000 and 1 <= options.seconds <= 300 and
            1 <= options.bound <= 600):
        parser.error('--rate must be 1-2000, --seconds 1-300 and --bound 1-600')
    report = Report()
    try:
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        status = loader.login(read_password(options.password_file))
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return report.result()
        result = start_task_writer(report, options, loader, Cluster(options.kubectl),
                                   options.run_id, options.rate, options.seconds,
                                   bound=options.bound)
        code = report.result()
        if result is None or code:
            return code or 1
        pod, module = result
        print('TASK_WRITER_RESULT ' + json.dumps({'pod': pod, 'module': module,
                                                'run_id': options.run_id}))
        return 0
    except WalkError:
        report.fail('the task writer runs', 'task_writer_failed')
        return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
