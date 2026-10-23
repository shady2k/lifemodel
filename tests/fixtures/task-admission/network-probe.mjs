// Run only by the coordinator through admin kubectl exec in an admitted task Pod.
// No token/credential read. DNS and TCP reachability are distinct assertions.
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
const [apiService, apiNode, postgres, valkey, seaweed] = process.argv.slice(2);
if (![apiService, apiNode, postgres, valkey, seaweed].every(Boolean))
  throw new Error('five target IPs required: API Service, API node, Postgres, Valkey, SeaweedFS');
await lookup('storage-module.lifemodel-system.svc');
console.log('PASS storage Service DNS');
function reaches(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(2500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
// Prove the client tools work through an allowed route before claiming denial.
if (!(await reaches('storage-module.lifemodel-system.svc', 8443)))
  throw new Error('allowed storage transport failed: network walk inconclusive');
console.log('PASS allowed storage TCP 8443');
for (const [name, host, port] of [
  ['internet', '1.1.1.1', 443],
  ['API Service', apiService, 443],
  ['API node', apiNode, 6443],
  ['Postgres', postgres, 5432],
  ['Valkey', valkey, 6379],
  ['SeaweedFS', seaweed, 8333],
]) {
  if (await reaches(host, port)) throw new Error(`FORBIDDEN route reachable: ${name}`);
  console.log(`PASS denied ${name}`);
}
