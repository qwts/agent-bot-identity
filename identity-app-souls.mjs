// The souls as identity-apps.mjs sees them: the census and each soul's
// soul.json credential declaration, passed in as `souls` (#645). Identity may
// not import soul, so the composition roots wire this port:
// cli/identity-apps.mjs for `agent-bot identity apps|app|addon` and
// agent-daemon.mjs for the daemon's App routes. Each call takes the App
// operation's own options (env, home, config), as identity-apps.mjs passed
// them to the census before.
import { listSouls, populationFile, setSoulApp, showSoul, soulDirectory } from './agent-population.mjs';
import { soulCredentialsDeclaration } from './soul-package.mjs';

export const identityAppSouls = Object.freeze({
  list: (options) => listSouls({ file: populationFile(options) }),
  show: (id, options) => showSoul(id, { file: populationFile(options) }),
  directory: (id, options) => soulDirectory(id, { ...options, file: populationFile(options) }),
  declaration: (directory) => soulCredentialsDeclaration(directory),
  assignApp: (id, app, options) => setSoulApp(id, app, { file: populationFile(options) }),
});
