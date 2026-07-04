import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';

// nvidia-smi PIDs are host-namespace PIDs; /proc/<pid>/cgroup read on the host
// contains the Docker container id, resolved to a TrueNAS app name via
// `midclt call app.query` (docker.sock is not accessible to truenas_admin).
const SCRIPT = `
apps=$(nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null) || exit 0
[ -z "$apps" ] && exit 0
map=$(midclt call app.query 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in data:
    for c in (a.get("active_workloads") or {}).get("container_details") or []:
        cid = c.get("id")
        name = a.get("name")
        if cid and name:
            print(cid, name)
' 2>/dev/null)
echo "$apps" | while IFS= read -r line; do
  bus=\${line%%,*}
  rest=\${line#*, }
  pid=\${rest%%,*}
  rest=\${rest#*, }
  mem=\${rest##*, }
  name=\${rest%, *}
  cid=$(grep -oE "[0-9a-f]{64}" "/proc/$pid/cgroup" 2>/dev/null | head -1)
  cname="-"
  [ -n "$cid" ] && cname=$(printf "%s\\n" "$map" | awk -v id="$cid" '$1==id{print $2}')
  [ -z "$cname" ] && cname="-"
  printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$bus" "$pid" "$cname" "$name" "$mem"
done
`;

export function getGpuProcs() {
  return cached('gpuProcs', 2_000, async () => {
    const output = await sshExec(SCRIPT);
    const procs = output.split('\n').filter(Boolean).map(line => {
      const [busId, pid, container, binary, vramMb] = line.split('\t');
      return {
        busId,
        pid: parseInt(pid) || 0,
        container: container === '-' ? null : container,
        binary: binary || '',
        vramMb: parseInt(vramMb) || 0,
      };
    });
    return { procs };
  });
}
