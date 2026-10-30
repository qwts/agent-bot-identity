// agent-bot machine <pair|unpair|status> (#1254): pairing between this
// account's agent-daemon and the local agent-machine daemon. Pair and
// unpair change machine-level trust and go through the owner gate like
// every other owner action; status is read-only.
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { assertOwnerAction } from '../owner-action.mjs';
import {
  AGENT_MACHINE_DIR, buildRequest, machineCall, machineSocketPath,
  loadOrCreateMachineKey, loadMachinePublicKey, pairedPublicKey, pinDaemonPub, verifyResponse,
  writeAgentDaemonPeer, unpairAgentDaemon, machineStateDir,
} from '../machine-client.mjs';

const USAGE = `usage: agent-bot machine <command>
  pair [--repin]   trust this account's agent-daemon key with agent-machine and pin daemon.pub
  unpair           revoke the agent-daemon peer and drop the daemon.pub pin
  status           show pairing state, then a signed agent-machine status round trip when paired`;

async function statusRoundTrip({ home, env }) {
  const pinned = pairedPublicKey({ env, home });
  const signer = loadOrCreateMachineKey({ env, home });
  const request = buildRequest({ verb: 'status' }, signer);
  const line = await machineCall({ socketPath: machineSocketPath({ home }), request });
  return verifyResponse(line, pinned, { expectedNonce: request.nonce });
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const env = process.env;
  const home = homedir();
  if (command === 'pair') {
    const repin = rest.includes('--repin');
    await assertOwnerAction('machine-pair', { env });
    const peersDir = join(AGENT_MACHINE_DIR(home), 'peers');
    if (!existsSync(AGENT_MACHINE_DIR(home))) {
      throw new Error(`${AGENT_MACHINE_DIR(home)} does not exist — install and start agent-machine first (managed-machine daemon install) [machine-not-running]`);
    }
    const key = loadOrCreateMachineKey({ env, home });
    writeAgentDaemonPeer({ home, publicKeyRaw: key.publicKeyRaw });
    const pin = pinDaemonPub({ env, home, repin });
    if (pin.replaced) process.stdout.write(`daemon.pub changed: ${pin.replaced} -> ${pin.fingerprint}\n`);
    process.stdout.write(`agent-machine pinned: sha256 ${pin.fingerprint}\n`);
    const reply = await statusRoundTrip({ home, env });
    if (!reply.ok) throw new Error(`pairing staged but agent-machine refused the status check: ${reply.diagnostic ?? ''} ${reply.message ?? ''}`.trim());
    process.stdout.write(`paired: agent-machine accepted the agent-daemon key (${reply.state ?? reply.message ?? 'ok'})\n`);
    return;
  }
  if (command === 'unpair') {
    await assertOwnerAction('machine-unpair', { env });
    unpairAgentDaemon({ env, home });
    process.stdout.write('unpaired: peers/agent-daemon.revoked written and the daemon.pub pin removed\n');
    return;
  }
  if (command === 'status') {
    const dir = AGENT_MACHINE_DIR(home);
    const peers = join(dir, 'peers');
    const pin = join(machineStateDir({ env, home }), 'daemon.pub.pin');
    const pairedFiles = existsSync(peers)
      ? ['.pub', '.next', '.confirm', '.revoked'].filter((suffix) => existsSync(join(peers, `agent-daemon${suffix}`)))
      : [];
    process.stdout.write(`agent-machine dir: ${existsSync(dir) ? dir : 'absent'}\n`);
    process.stdout.write(`pin: ${existsSync(pin) ? 'present' : 'absent'}; peer files: ${pairedFiles.length ? pairedFiles.join(', ') : 'none'}\n`);
    if (loadMachinePublicKey({ env, home }) === null) {
      process.stdout.write('client key: absent\n');
      return;
    }
    if (!existsSync(pin)) return;
    try {
      const reply = await statusRoundTrip({ home, env });
      process.stdout.write(`status: ${reply.ok ? 'ok' : 'refused'}${reply.state ? ` (${reply.state})` : ''}${reply.diagnostic ? ` [${reply.diagnostic}]` : ''}${reply.message ? ` ${reply.message}` : ''}\n`);
    } catch (error) {
      process.stdout.write(`status: ${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = command ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-bot machine: ${error.message}\n`);
    process.exit(1);
  });
}
