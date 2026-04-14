import assert from 'node:assert/strict';
import {
  GpuGuardService,
  evaluateGpuReasons,
  parseNvidiaSmiCsv
} from '../core/runtime/gpuGuardService';
import type { GpuGuardPolicy } from '../core/types';
import type { TestCase } from './toolRuntime.test';

const basePolicy: GpuGuardPolicy = {
  enabled: true,
  provider: 'auto',
  maxTemperatureC: 80,
  maxUtilizationPercent: 90,
  pollIntervalMs: 5000,
  action: 'pause'
};

export const gpuGuardServiceTests: TestCase[] = [
  {
    name: 'parseNvidiaSmiCsv reads device metrics and thresholds',
    async run() {
      const devices = parseNvidiaSmiCsv('NVIDIA RTX 3070 Ti, 83, 91\nNVIDIA RTX 3050, 52, 13\n');
      const reasons = evaluateGpuReasons(devices, basePolicy);

      assert.equal(devices.length, 2);
      assert.deepEqual(devices[0], {
        name: 'NVIDIA RTX 3070 Ti',
        temperatureC: 83,
        utilizationPercent: 91
      });
      assert.deepEqual(reasons, [
        'NVIDIA RTX 3070 Ti temperature 83C >= 80C',
        'NVIDIA RTX 3070 Ti utilization 91% >= 90%'
      ]);
    }
  },
  {
    name: 'GpuGuardService returns throttled snapshot when a limit is exceeded',
    async run() {
      const service = new GpuGuardService({
        async queryNvidiaSmi() {
          return 'NVIDIA GeForce RTX 3070 Ti Laptop GPU, 82, 65\n';
        }
      });

      const snapshot = await service.sample(basePolicy);

      assert.equal(snapshot.status, 'throttled');
      assert.equal(snapshot.provider, 'nvidia-smi');
      assert.equal(snapshot.limitExceeded, true);
      assert.deepEqual(snapshot.reasons, ['NVIDIA GeForce RTX 3070 Ti Laptop GPU temperature 82C >= 80C']);
    }
  },
  {
    name: 'GpuGuardService returns unsupported when telemetry is unavailable',
    async run() {
      const service = new GpuGuardService({
        async queryNvidiaSmi() {
          const error = new Error('spawn nvidia-smi ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
      });

      const snapshot = await service.sample(basePolicy);

      assert.equal(snapshot.status, 'unsupported');
      assert.equal(snapshot.provider, 'unavailable');
      assert.equal(snapshot.limitExceeded, false);
      assert.equal(snapshot.devices.length, 0);
    }
  }
];
