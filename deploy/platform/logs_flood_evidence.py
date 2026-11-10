"""Independent Job stdout and PV-directory evidence for the flood walk."""
import os

from logs_flood_support import is_drop
from logs_walk_support import drop_line, now_ms, parse_ms


class FloodEvictorEvidence:
    """Cache evidence while successful Job history is only one run deep.

    Reread active pods: a readable but incomplete stdout is not the final log.
    Missing logs or unreadable partition directories never prove displacement.
    """

    def __init__(self, cluster, options, volume, since_ms):
        self.cluster, self.options, self.volume = cluster, options, volume
        self.since_ms = since_ms
        self.previous_days = {}
        self.disappeared = set()
        self.drops = {}

    def days(self):
        try:
            with os.scandir(os.path.join(self.volume.pv_path, 'partitions')) as entries:
                return {entry.name: (entry.stat(follow_symlinks=False).st_dev,
                                     entry.stat(follow_symlinks=False).st_ino)
                        for entry in entries
                        if len(entry.name) == 8 and entry.name.isdigit()
                        and entry.is_dir(follow_symlinks=False)}
        except OSError:
            return None

    def poll(self):
        # Sample before and after reading Jobs so a deletion during log retrieval
        # can be seen too. An unreadable scan breaks, rather than invents, a transition.
        self.observe_days()
        options = self.options
        body = self.cluster.json(['-n', options.namespace, 'get', 'jobs', '-o', 'json']) or {}
        for job in body.get('items', []):
            metadata = job.get('metadata') or {}
            owners = metadata.get('ownerReferences') or []
            created = parse_ms(metadata.get('creationTimestamp'))
            if (not any(owner.get('kind') == 'CronJob'
                        and owner.get('name') == getattr(options, 'cronjob', 'logs-evictor')
                        and owner.get('uid') for owner in owners)
                    or created is None or not self.since_ms <= created <= now_ms()
                    or not metadata.get('uid') or not metadata.get('name')):
                continue
            name, uid = metadata['name'], metadata['uid']
            for pod in self.cluster.pods(options.namespace, 'job-name=' + name):
                pod_meta = pod.get('metadata') or {}
                if (not pod_meta.get('name') or not pod_meta.get('uid')
                        or (pod_meta.get('labels') or {}).get('job-name') != name
                        or not any(owner.get('kind') == 'Job' and owner.get('uid') == uid
                                   and owner.get('name') == name
                                   for owner in pod_meta.get('ownerReferences') or [])):
                    continue
                result = self.cluster.run(
                    ['-n', options.namespace, 'logs', pod_meta['name'], '--timestamps',
                     '--tail=2000', '--limit-bytes=1048576'], timeout=30)
                if result.returncode != 0:
                    continue
                for raw in result.stdout.splitlines():
                    timestamp, separator, message = raw.partition(' ')
                    moment = parse_ms(timestamp)
                    if (not separator or moment is None
                            or not max(self.since_ms, created) <= moment <= now_ms()):
                        continue
                    record = {'module': 'logs-evictor', 'time': timestamp, 'message': message}
                    if is_drop(record):
                        line = drop_line(record)
                        self.drops[(uid, pod_meta['uid'], moment, line['day'])] = line
        self.observe_days()

    def observe_days(self):
        present = self.days()
        if present is None:
            self.previous_days = {}
            return
        self.disappeared.update(day for day, identity in self.previous_days.items()
                                if present.get(day) != identity)
        self.previous_days = present

    def verified(self, report):
        verified = []
        for line in sorted(self.drops.values(), key=lambda item: item['time']):
            if line['day'] not in self.disappeared:
                continue
            report.pass_("the evictor's dropped day disappeared from the volume",
                         '%s freed %d bytes (%s); own Job pod stdout and PV directory transition'
                         % (line['day'], line['freedBytes'], line['reason']))
            verified.append(line)
        return verified
