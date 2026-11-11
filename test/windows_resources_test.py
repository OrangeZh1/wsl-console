import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / 'scripts/windows_resources.py'
spec = importlib.util.spec_from_file_location('windows_resources', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SESSION = '11111111-1111-4111-8111-111111111111'
GIB = 1024**3


class SharedResourceContract(unittest.TestCase):
    def setUp(self):
        self.clock = 10.0
        self.reader = module.WindowsResourceReader('anonymous-unused.json', SESSION, now=lambda: self.clock)

    def frame(self, seq=1, **changes):
        return dict(format='wsl-windows-resource-v1', producerId=SESSION, sequence=seq,
                    sourceMonotonicMs=seq*2000, sampleDurationMs=20, sampledAt='1990-01-01T00:00:00Z',
                    status='available', memory=dict(availableBytes=4*GIB, totalBytes=16*GIB), **changes)

    def ready(self):
        self.assertEqual(self.reader.observe(self.frame())['status'], 'warming')
        self.clock += 2
        result = self.reader.observe(self.frame(2))
        self.assertTrue(result['ready'])
        return result

    def test_initial_historical_file_needs_advancing_sequence(self):
        self.assertFalse(self.reader.observe(self.frame(50))['ready'])
        self.clock += 20
        self.assertEqual(self.reader.observe(self.frame(50))['status'], 'stale')

    def test_wall_date_jumps_do_not_change_freshness(self):
        self.ready()
        changed = self.frame(3)
        changed['sampledAt'] = '2099-01-01T00:00:00Z'
        self.clock += 2
        self.assertTrue(self.reader.observe(changed)['ready'])

    def test_frozen_sequence_never_renews_local_receive_age(self):
        self.ready()
        self.clock += 7
        self.assertTrue(self.reader.observe(self.frame(2))['ready'])
        self.clock += 2
        self.assertEqual(self.reader.observe(self.frame(2))['status'], 'stale')

    def test_wrong_producer_regression_and_same_sequence_mutation_fail_closed(self):
        self.ready()
        wrong = self.frame(3)
        wrong['producerId'] = '22222222-2222-4222-8222-222222222222'
        self.assertEqual(self.reader.observe(wrong)['status'], 'invalid')
        self.assertEqual(self.reader.observe(self.frame(1))['status'], 'invalid')
        mutation = self.frame(2)
        mutation['memory']['availableBytes'] -= 1
        self.assertEqual(self.reader.observe(mutation)['status'], 'invalid')

    def test_failed_slow_or_stopped_samples_cannot_reuse_prior_memory(self):
        self.ready()
        for status in ('unavailable', 'stopped'):
            frame = self.frame(3)
            frame.update(status=status, memory=None)
            self.assertFalse(self.reader.observe(frame)['ready'])
        slow = self.frame(4)
        slow['sampleDurationMs'] = 6000
        self.assertFalse(self.reader.observe(slow)['ready'])

    def test_resource_gates_keep_peak_margin_and_low_water_and_ignore_swap_as_free_memory(self):
        windows = self.ready()
        linux = dict(availableBytes=3*GIB, swapFreeBytes=100*GIB)
        gate = module.evaluate_resource_gate(windows, linux, peak_bytes=2*GIB)
        self.assertTrue(gate['allowed'])
        self.assertEqual(gate['windowsRequiredBytes'], 3*GIB)
        self.assertEqual(gate['linuxRequiredBytes'], int(2.5*GIB))
        self.assertFalse(module.evaluate_resource_gate(windows, dict(availableBytes=GIB, swapFreeBytes=100*GIB))['allowed'])
        self.assertEqual(module.evaluate_resource_gate(dict(ready=False, reason='stale'), linux, mode='low-water')['decision'], 'interrupt')
        self.assertEqual(module.evaluate_resource_gate(dict(ready=True, availableBytes=GIB-1), linux, mode='low-water')['decision'], 'interrupt')


if __name__ == '__main__':
    unittest.main()
