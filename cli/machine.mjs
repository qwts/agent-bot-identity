// agent-bot machine <pair|unpair|status> and top-level `agent-bot pair|unpair`
// (#1254, #1295): pairing between this account's agent-daemon and the local
// agent-machine daemon (or `pair comms` for the agent-comms broker). Pair and
// unpair change machine-level trust and go through the owner gate like
// every other owner action; status is read-only.
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { assertOwnerAction } from '../owner-action.mjs';
import {
  AGENT_MACHINE_DIR, buildRequest, machineCall, machineSocketPath,
  loadOrCreateMachineKey, loadMachinePublicKey, pairedPublicKey, pinDaemonPub, verifyResponse,
  writeAgentDaemonPeer, unpairAgentDaemon, machineStateDir,
} from '../machine-client.mjs';

const USAGE = `usage: agent-bot machine <command> | agent-bot pair [--repin] | agent-bot unpair
  pair [--repin]               trust this account's agent-daemon key with agent-machine and pin daemon.pub
  pair comms [--broker NAME]   pair this daemon with the agent-comms broker (alias for daemon pair-comms)
  unpair                       revoke the agent-daemon peer and drop the daemon.pub pin
  status                       show pairing state, then a signed agent-machine status round trip when paired`;

async function statusRoundTrip({ home, env, socketPath = machineSocketPath({ home }), connectImpl }) {
  const pinned = pairedPublicKey({ env, home });
  const signer = loadOrCreateMachineKey({ env, home });
  const request = buildRequest({ verb: 'status' }, signer);
  const line = await machineCall({ socketPath, request, ...(connectImpl ? { connectImpl } : {}) });
  return verifyResponse(line, pinned, { expectedNonce: request.nonce });
}

export async function runMachineCli(argv = process.argv.slice(2), {
  env = process.env,
  home = homedir(),
  stdout = process.stdout,
  stderr = process.stderr,
  gate = assertOwnerAction,
  socketPath,
  connectImpl,
} = {}) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || rest.includes('--help') || rest.includes('-h')) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === 'pair') {
    const repin = rest.includes('--repin');
    const unexpected = rest.filter((arg) => arg !== '--repin' && arg !== 'machine');
    if (unexpected.length > 0) {
      stderr.write(`${USAGE}\n`);
      return 1;
    }
    await gate('machine-pair', { env });
    if (!existsSync(AGENT_MACHINE_DIR(home))) {
      throw new Error(`${AGENT_MACHINE_DIR(home)} does not exist — install and start agent-machine first (managed-machine daemon install) [machine-not-running]`);
    }
    const key = loadOrCreateMachineKey({ env, home });
    writeAgentDaemonPeer({ home, publicKeyRaw: key.publicKeyRaw });
    const pin = pinDaemonPub({ env, home, repin });
    if (pin.replaced) stdout.write(`daemon.pub changed: ${pin.replaced} -> ${pin.fingerprint}\n`);
    stdout.write(`agent-machine pinned: sha256 ${pin.fingerprint}\n`);
    const reply = await statusRoundTrip({ home, env, ...(socketPath ? { socketPath } : {}), ...(connectImpl ? { connectImpl } : {}) });
    if (!reply.ok) throw new Error(`pairing staged but agent-machine refused the status check: ${reply.diagnostic ?? ''} ${reply.message ?? ''}`.trim());
    stdout.write(`paired: agent-machine accepted the agent-daemon key (${reply.state ?? reply.message ?? 'ok'})\n`);
    return 0;
  }
  if (command === 'unpair') {
    const unexpected = rest.filter((arg) => arg !== 'machine');
    if (unexpected.length > 0) {
      stderr.write(`${USAGE}\n`);
      return 1;
    }
    await gate('machine-unpair', { env });
    unpairAgentDaemon({ env, home });
    stdout.write('unpaired: peers/agent-daemon.revoked written and the daemon.pub pin removed\n');
    return 0;
  }
  if (command === 'status') {
    const dir = AGENT_MACHINE_DIR(home);
    const peers = join(dir, 'peers');
    const pin = join(machineStateDir({ env, home }), 'daemon.pub.pin');
    const pairedFiles = existsSync(peers)
      ? ['.pub', '.next', '.confirm', '.revoked'].filter((suffix) => existsSync(join(peers, `agent-daemon${suffix}`)))
      : [];
    stdout.write(`agent-machine dir: ${existsSync(dir) ? dir : 'absent'}\n`);
    stdout.write(`pin: ${existsSync(pin) ? 'present' : 'absent'}; peer files: ${pairedFiles.length ? pairedFiles.join(', ') : 'none'}\n`);
    if (loadMachinePublicKey({ env, home }) === null) {
      stdout.write('client key: absent\n');
      return 0;
    }
    if (!existsSync(pin)) return 0;
    try {
      const reply = await statusRoundTrip({ home, env, ...(socketPath ? { socketPath } : {}), ...(connectImpl ? { connectImpl } : {}) });
      stdout.write(`status: ${reply.ok ? 'ok' : 'refused'}${reply.state ? ` (${reply.state})` : ''}${reply.diagnostic ? ` [${reply.diagnostic}]` : ''}${reply.message ? ` ${reply.message}` : ''}\n`);
    } catch (error) {
      stdout.write(`status: ${error.message}\n`);
      return 1;
    }
    return 0;
  }
  stderr.write(`${USAGE}\n`);
  return command ? 1 : 0;
}

async function main(argv = process.argv.slice(2)) {
  const code = await runMachineCli(argv);
  if (code !== 0) process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-bot machine: ${error.message}\n`);
    process.exit(1);
  });
}
