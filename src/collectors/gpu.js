import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';

const QUERY = [
  'index',
  'pci.bus_id',
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
].join(',');

export function getGpuStatus() {
  return cached('gpu', 2_000, async () => {
    const output = await sshExec(
      `nvidia-smi --query-gpu=${QUERY} --format=csv,noheader,nounits`
    );
    const gpus = output.split('\n').filter(Boolean).map(line => {
      const [index, busId, name, utilization, memUsed, memTotal, temperature, powerDraw] =
        line.split(', ').map(s => s.trim());
      return {
        index: parseInt(index) || 0,
        busId,
        name,
        utilization: parseInt(utilization) || 0,
        memUsed: parseInt(memUsed) || 0,
        memTotal: parseInt(memTotal) || 0,
        temperature: parseInt(temperature) || 0,
        powerDraw: parseFloat(powerDraw) || 0,
      };
    });
    return { gpus };
  });
}
