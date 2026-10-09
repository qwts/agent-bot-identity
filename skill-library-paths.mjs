// Shared location contract for local acquisition and cooperative write guards.
import { homedir } from 'node:os';
import path from 'node:path';
export function skillLibraryRoot({ env = process.env, home = env.HOME ?? homedir(), skillsRoot } = {}) {
  const override = skillsRoot ?? env.AGENT_BOT_SKILLS_HOME;
  if (override !== undefined && (typeof override !== 'string' || !path.isAbsolute(override) || override.includes('\0'))) {
    throw Object.assign(new Error('AGENT_BOT_SKILLS_HOME must be an absolute directory path'), { code: 'skill-root-invalid' });
  }
  return path.resolve(override ?? path.join(home, '.agent-bot', 'skills'));
}
