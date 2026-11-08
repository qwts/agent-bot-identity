// The MCP tool registry (HQ plan Stage 0 row 9, #1394). Each MCP server
// registers its member tools here, one declaration per tool, and reads
// tools/list, discovery and calls back from it. This is the in-place seam for
// plugin registration in HQ (plan §4.2, `ctx.tools.register(tool)`): a tool
// declares its name, schema, class and handler in one place, and the server
// owns the protocol and the dispatch. Like the daemon's route registry
// (route-registry.mjs, row 8), it refuses what it does not know.
//
// createToolRegistry({ server, conditions }) takes the server's name, used in
// refusals, and the conditions its tools may be listed under (none by
// default). A tool is { name, description, inputSchema, class, handler,
// annotations?, when? }:
//
// - name: the MCP tool name, lowercase letters, digits and underscores.
// - description, inputSchema, annotations: what tools/list shows, as given.
//   The schema is a JSON Schema with type "object".
// - class: 'read' or 'write', what the server allows a call through.
// - handler: the function the server calls. Its arguments are the server's.
// - when: the conditions that must all hold for the tool to be listed, each
//   one of the registry's conditions. A server decides what each one means
//   for a session; the registry only filters by them.
//
// A name has exactly one declaration, and list() keeps registration order,
// because tools/list shows it. `close()` ends registration, as HQ closes it
// after init (§4.4).

export const TOOL_CLASSES = Object.freeze(['read', 'write']);

const SERVER = /^[a-z0-9-]{1,64}$/;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CONDITION = /^[a-z][a-z0-9-]{0,63}$/;
const KEYS = new Set(['name', 'description', 'inputSchema', 'annotations', 'class', 'when', 'handler']);

function refuse(message) {
  throw Object.assign(new Error(`tool registry: ${message}`), { code: 'tool-registry-invalid' });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createToolRegistry({ server, conditions = [], ...rest } = {}) {
  if (typeof server !== 'string' || !SERVER.test(server)) refuse(`server ${JSON.stringify(server)} must match ${SERVER}`);
  if (Object.keys(rest).length) refuse(`${server}: unknown option ${Object.keys(rest)[0]}`);
  if (!Array.isArray(conditions) || !conditions.every((condition) => typeof condition === 'string' && CONDITION.test(condition))
    || new Set(conditions).size !== conditions.length) {
    refuse(`${server}: conditions is a list of distinct names matching ${CONDITION}`);
  }
  const known = new Set(conditions);
  const tools = new Map();
  let closed = false;

  function register(tool) {
    if (closed) refuse(`${server}: registration is closed`);
    if (!plainObject(tool)) refuse(`${server}: a tool is an object`);
    const { name, description, inputSchema, annotations, class: cls, when, handler } = tool;
    if (typeof name !== 'string' || !NAME.test(name)) refuse(`${server}: tool name ${JSON.stringify(name)} must match ${NAME}`);
    for (const key of Object.keys(tool)) if (!KEYS.has(key)) refuse(`${server}: ${name} has an unknown field ${key}`);
    if (tools.has(name)) refuse(`${server}: ${name} is already registered`);
    if (typeof description !== 'string' || description.trim() === '') refuse(`${server}: ${name} needs a description`);
    if (!plainObject(inputSchema) || inputSchema.type !== 'object') refuse(`${server}: ${name} needs an inputSchema of type object`);
    if (annotations !== undefined && !plainObject(annotations)) refuse(`${server}: ${name}: annotations is an object`);
    if (!TOOL_CLASSES.includes(cls)) refuse(`${server}: ${name} needs a class, one of ${TOOL_CLASSES.join(', ')}`);
    if (when !== undefined && (!Array.isArray(when) || when.length === 0 || new Set(when).size !== when.length
      || !when.every((condition) => known.has(condition)))) {
      refuse(`${server}: ${name}: when lists distinct conditions of this server (${[...known].join(', ') || 'none'})`);
    }
    if (typeof handler !== 'function') refuse(`${server}: ${name}: handler must be a function`);
    tools.set(name, Object.freeze({
      name, description, inputSchema,
      ...(annotations !== undefined ? { annotations } : {}),
      class: cls,
      when: Object.freeze([...(when ?? [])]),
      handler,
    }));
  }

  // The declaration for a name, or null.
  function get(name) {
    return tools.get(name) ?? null;
  }

  // The tools/list entries, in registration order, of the tools whose
  // conditions all hold. `holds(condition)` answers for one condition.
  function list(holds = () => true) {
    return [...tools.values()]
      .filter((tool) => tool.when.every((condition) => holds(condition)))
      .map(({ name, description, inputSchema, annotations }) => ({
        name, description, inputSchema, ...(annotations !== undefined ? { annotations } : {}),
      }));
  }

  return Object.freeze({
    server,
    register,
    get,
    list,
    names: () => [...tools.keys()],
    entries: () => [...tools.values()],
    close() { closed = true; },
  });
}
