// The subcommand -> reference table lives in skill-for-map.mjs (module
// `shared`) so the MCP server's `guide` tool reads the same map (#226).
import { SKILL_REFERENCES, NO_SKILL_REFERENCE, skillReferenceFor } from '../skill-for-map.mjs';

export { SKILL_REFERENCES, NO_SKILL_REFERENCE, skillReferenceFor };
