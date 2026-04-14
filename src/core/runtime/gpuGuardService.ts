import { execFile } from 'child_process';
import type { GpuDeviceSnapshot, GpuGuardPolicy, GpuGuardSnapshot } from '../types';

export interface GpuMetricsBackend {
  queryNvidiaSmi(signal?: AbortSignal): Promise<string>;
}

export class ChildProcessGpuMetricsBackend implements GpuMetricsBackend {
  public queryNvidiaSmi(signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'nvidia-smi',
        ['--query-gpu=name,temperature.gpu,utilization.gpu', '--format=csv,noheader,nounits'],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 4000,
          signal
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(stdout);
        }
      );
    });
  }
}

export class GpuGuardService {
  public constructor(private readonly backend: GpuMetricsBackend = new ChildProcessGpuMetricsBackend()) {}

  public async sample(policy: GpuGuardPolicy, signal?: AbortSignal): Promise<GpuGuardSnapshot> {
    if (!policy.enabled || policy.provider === 'off') {
      return createEmptyGpuGuardSnapshot(policy, 'disabled', 'off');
    }

    try {
      const rawOutput = await this.backend.queryNvidiaSmi(signal);
      const devices = parseNvidiaSmiCsv(rawOutput);
      const reasons = evaluateGpuReasons(devices, policy);

      return {
        policy,
        status: reasons.length > 0 ? 'throttled' : 'ready',
        provider: 'nvidia-smi',
        updatedAt: new Date().toISOString(),
        devices,
        limitExceeded: reasons.length > 0,
        reasons
      };
    } catch (error) {
      if (isCommandUnavailable(error)) {
        return {
          ...createEmptyGpuGuardSnapshot(policy, 'unsupported', 'unavailable'),
          error: 'GPU telemetry is unavailable on this machine.'
        };
      }

      return {
        ...createEmptyGpuGuardSnapshot(policy, 'error', 'unavailable'),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

export function createEmptyGpuGuardSnapshot(
  policy: GpuGuardPolicy,
  status: GpuGuardSnapshot['status'] = policy.enabled ? 'unsupported' : 'disabled',
  provider: GpuGuardSnapshot['provider'] = policy.enabled ? 'unavailable' : 'off'
): GpuGuardSnapshot {
  return {
    policy,
    status,
    provider,
    devices: [],
    limitExceeded: false,
    reasons: []
  };
}

export function parseNvidiaSmiCsv(output: string): GpuDeviceSnapshot[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, rawTemperature, rawUtilization] = line.split(',').map((part) => part.trim());
      return {
        name: name || 'Unknown GPU',
        temperatureC: parseOptionalNumber(rawTemperature),
        utilizationPercent: parseOptionalNumber(rawUtilization)
      };
    });
}

export function evaluateGpuReasons(devices: GpuDeviceSnapshot[], policy: GpuGuardPolicy): string[] {
  const reasons: string[] = [];

  for (const device of devices) {
    if (
      typeof policy.maxTemperatureC === 'number' &&
      typeof device.temperatureC === 'number' &&
      device.temperatureC >= policy.maxTemperatureC
    ) {
      reasons.push(`${device.name} temperature ${device.temperatureC}C >= ${policy.maxTemperatureC}C`);
    }

    if (
      typeof policy.maxUtilizationPercent === 'number' &&
      typeof device.utilizationPercent === 'number' &&
      device.utilizationPercent >= policy.maxUtilizationPercent
    ) {
      reasons.push(
        `${device.name} utilization ${device.utilizationPercent}% >= ${policy.maxUtilizationPercent}%`
      );
    }
  }

  return reasons;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value || value === '[Not Supported]' || value === 'N/A') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCommandUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const typedError = error as NodeJS.ErrnoException;
  return typedError.code === 'ENOENT' || typedError.message.includes('not recognized');
}
