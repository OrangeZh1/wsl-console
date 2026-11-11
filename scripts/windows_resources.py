"""Read-only shared Windows memory snapshots; freshness uses local monotonic time."""
import argparse
import json
import math
import pathlib
import time
import uuid


class WindowsResourceReader:
    def __init__(self, path, producer_id, *, stale_after_ms=8000, max_acquisition_ms=5000, now=time.monotonic):
        self.path = pathlib.Path(path)
        self.producer_id = str(uuid.UUID(producer_id))
        if not 500 <= stale_after_ms <= 60000 or not 0 < max_acquisition_ms <= stale_after_ms:
            raise ValueError('invalid resource freshness bounds')
        self.stale_after_ms = stale_after_ms
        self.max_acquisition_ms = max_acquisition_ms
        self.now = now
        self.sequence = None
        self.source_mono = None
        self.received = None
        self.fingerprint = None
        self.advanced = False
        self.last_now = None

    def _result(self, status, reason, frame=None):
        memory = frame.get('memory') if status == 'ready' and frame else None
        age = None if self.received is None else max(0, (self.now() - self.received) * 1000)
        return dict(ready=status == 'ready', status=status, reason=reason,
                    availableBytes=memory['availableBytes'] if memory else None,
                    totalBytes=memory['totalBytes'] if memory else None,
                    producerId=self.producer_id, sequence=self.sequence, ageMs=age)

    def read(self):
        try:
            with self.path.open('rb') as stream:
                raw = stream.read(16385)
            if len(raw) > 16384:
                return self._result('invalid', 'resource file exceeds 16KiB')
            frame = json.loads(raw.decode('utf-8-sig'))
        except (OSError, ValueError):
            return self._result('unavailable', 'resource file missing or unreadable')
        return self.observe(frame)

    def observe(self, frame):
        current = self.now()
        if self.last_now is not None and current < self.last_now:
            return self._result('invalid', 'consumer monotonic clock regressed')
        self.last_now = current
        if not isinstance(frame, dict) or frame.get('format') != 'wsl-windows-resource-v1' or frame.get('producerId') != self.producer_id:
            return self._result('invalid', 'resource producer or format mismatch')
        seq, source = frame.get('sequence'), frame.get('sourceMonotonicMs')
        duration = frame.get('sampleDurationMs')
        if type(seq) is not int or seq < 1 or not _number(source) or source < 0 or not _number(duration) or duration < 0:
            return self._result('invalid', 'resource sequence or source monotonic point invalid')
        fingerprint = json.dumps(frame, sort_keys=True, separators=(',', ':'))
        if self.sequence is not None:
            if seq < self.sequence or source < self.source_mono:
                return self._result('invalid', 'resource sequence regressed; restart needs a new producer UUID')
            if seq == self.sequence and fingerprint != self.fingerprint:
                return self._result('invalid', 'same sequence changed its payload')
            if seq > self.sequence and source <= self.source_mono:
                return self._result('invalid', 'sequence advanced without source monotonic progress')
            if seq > self.sequence:
                self.advanced = True
                self.received = current
        else:
            self.received = current
        self.sequence, self.source_mono, self.fingerprint = seq, source, fingerprint
        if (current - self.received) * 1000 > self.stale_after_ms:
            return self._result('stale', 'producer sequence stopped advancing')
        if frame.get('status') != 'available':
            return self._result('unavailable', 'producer reports unavailable or stopped')
        memory = frame.get('memory')
        if not isinstance(memory, dict) or any(type(memory.get(k)) is not int for k in ('availableBytes', 'totalBytes')) or not 0 <= memory['availableBytes'] <= memory['totalBytes'] <= 2**53-1 or memory['totalBytes'] <= 0:
            return self._result('invalid', 'resource memory range invalid')
        if duration > self.max_acquisition_ms:
            return self._result('unavailable', 'resource acquisition exceeded its bound')
        if not self.advanced:
            return self._result('warming', 'waiting for a second advancing producer sequence')
        return self._result('ready', 'advancing sample within monotonic freshness bound', frame)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def read_linux_resources(path='/proc/meminfo'):
    fields = {}
    for line in pathlib.Path(path).read_text().splitlines():
        name, *parts = line.replace(':', ' ').split()
        if name in ('MemAvailable', 'MemTotal', 'SwapTotal', 'SwapFree'):
            fields[name] = int(parts[0]) * 1024
    return dict(availableBytes=fields['MemAvailable'], totalBytes=fields['MemTotal'],
                swapTotalBytes=fields['SwapTotal'], swapFreeBytes=fields['SwapFree'])


def evaluate_resource_gate(windows, linux, *, mode='admission', peak_bytes=0):
    if mode not in ('admission', 'low-water') or type(peak_bytes) is not int or peak_bytes < 0:
        raise ValueError('invalid resource gate mode or peak budget')
    gib = 1024**3
    win_required = max(int(2.5 * gib), peak_bytes + gib) if mode == 'admission' else gib
    linux_required = max(2 * gib, peak_bytes + gib // 2) if mode == 'admission' else gib // 2
    win = windows.get('availableBytes') if windows.get('ready') else None
    available = linux.get('availableBytes')
    allowed = type(win) is int and type(available) is int and win >= win_required and available >= linux_required
    reason = 'resource admission passed' if allowed else windows.get('reason') if not windows.get('ready') else 'available memory below resource threshold'
    return dict(allowed=allowed, decision='ready' if allowed else 'wait' if mode == 'admission' else 'interrupt',
                reason=reason, windowsAvailableBytes=win, linuxAvailableBytes=available,
                windowsRequiredBytes=win_required, linuxRequiredBytes=linux_required)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', required=True)
    parser.add_argument('--producer-id', required=True)
    parser.add_argument('--wait-ready', type=float, default=12)
    parser.add_argument('--mode', choices=('admission', 'low-water'), default='admission')
    parser.add_argument('--peak-bytes', type=int, default=0)
    args = parser.parse_args()
    reader = WindowsResourceReader(args.file, args.producer_id)
    deadline = time.monotonic() + max(0, min(args.wait_ready, 60))
    while True:
        windows = reader.read()
        if windows['ready'] or time.monotonic() >= deadline:
            break
        time.sleep(.25)
    result = evaluate_resource_gate(windows, read_linux_resources(), mode=args.mode, peak_bytes=args.peak_bytes)
    print(json.dumps(dict(windows=windows, gate=result), ensure_ascii=False))
    return 0 if result['allowed'] else 75 if args.mode == 'admission' else 130


if __name__ == '__main__':
    raise SystemExit(main())
