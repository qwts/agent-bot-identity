// The MCP tool registry (tool-registry.mjs, #1394; HQ plan Stage 0 row 9).
// Both MCP servers register each tool once, with its schema, class, handler
// and listing conditions. This file checks the registry refuses what it does
// not know, keeps each server's registry equal to the README's tables, and
// pins the classes and listing sets the servers had before the registry.
// tests/golden-surface.test.mjs pins what tools/list shows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createToolRegistry, TOOL_CLASSES } from '../tool-registry.mjs';
import { MEMBER_TOOLS } from '../agent-mcp.mjs';
import { REACH_TOOL_NAMES, REACH_TOOLS } from '../daemon-mcp.mjs';

const root = path.join(import.meta.dirname, '..');
const handler = () => ({});
const tool = (overrides = {}) => ({
  name: 't', description: 'A tool.', inputSchema: { type: 'object', properties: {} }, class: 'read', handler, ...overrides,
});

// The README table that follows `marker`, as rows of cells.
function readmeTable(marker) {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const start = readme.indexOf(marker);
  assert.ok(start >= 0, `README has no ${marker}`);
  const rows = [];
  for (const line of readme.slice(readme.indexOf('\n| ', start) + 1).split('\n')) {
    if (!line.startsWith('| ')) break;
    rows.push(line.slice(2, -2).split(' | ').map((cell) => cell.replace(/^`|`$/g, '')));
  }
  return rows.slice(2);
}

test('a registry needs a server name and known options', () => {
  for (const options of [undefined, {}, { server: 'Bad Name' }, { server: 's', extra: 1 }, { server: 's', conditions: 'comms' },
    { server: 's', conditions: ['Comms'] }, { server: 's', conditions: ['a', 'a'] }]) {
    assert.throws(() => createToolRegistry(options), (error) => error.code === 'tool-registry-invalid', JSON.stringify(options));
  }
  assert.equal(createToolRegistry({ server: 's' }).server, 's');
});

test('a tool needs a name, description, object schema, class and handler, and only the fields it allows', () => {
  assert.deepEqual(TOOL_CLASSES, ['read', 'write']);
  const invalid = [
    null, [], 'tool',
    tool({ name: undefined }), tool({ name: 'Bad-Name' }), tool({ name: '1tool' }), tool({ name: 'x'.repeat(65) }),
    tool({ description: '' }), tool({ description: '  ' }), tool({ description: 1 }),
    tool({ inputSchema: undefined }), tool({ inputSchema: { type: 'string' } }), tool({ inputSchema: [] }),
    tool({ annotations: [] }), tool({ annotations: 'x' }),
    tool({ class: undefined }), tool({ class: 'admin' }),
    tool({ when: [] }), tool({ when: ['comms'] }), tool({ when: 'comms' }),
    tool({ handler: undefined }), tool({ handler: 'f' }),
    tool({ listed: false }), tool({ title: 'T' }),
  ];
  for (const declaration of invalid) {
    assert.throws(() => createToolRegistry({ server: 's' }).register(declaration),
      (error) => error.code === 'tool-registry-invalid', JSON.stringify(declaration));
  }
  const conditional = createToolRegistry({ server: 's', conditions: ['comms'] });
  assert.throws(() => conditional.register(tool({ when: ['comms', 'comms'] })), /distinct conditions/);
  assert.throws(() => conditional.register(tool({ when: ['invocation'] })), /distinct conditions of this server \(comms\)/);
  conditional.register(tool({ when: ['comms'] }));
});

test('a name is registered once, and registration closes', () => {
  const tools = createToolRegistry({ server: 's' });
  tools.register(tool({ name: 'a' }));
  assert.throws(() => tools.register(tool({ name: 'a', class: 'write' })), /s: a is already registered/);
  tools.register(tool({ name: 'b', class: 'write' }));
  tools.close();
  assert.throws(() => tools.register(tool({ name: 'c' })), /s: registration is closed/);
  assert.deepEqual(tools.names(), ['a', 'b']);
  assert.equal(tools.get('b').class, 'write');
  assert.equal(tools.get('c'), null);
  assert.equal(tools.get(undefined), null);
  assert.ok(Object.isFrozen(tools.get('a')) && Object.isFrozen(tools.get('a').when));
});

test('list keeps registration order, shows only the MCP fields, and filters by condition', () => {
  const tools = createToolRegistry({ server: 's', conditions: ['comms', 'invocation'] });
  const schema = { type: 'object', properties: { x: { type: 'string' } } };
  tools.register(tool({ name: 'z', inputSchema: schema, annotations: { readOnlyHint: true } }));
  tools.register(tool({ name: 'a', when: ['comms'] }));
  tools.register(tool({ name: 'm', when: ['comms', 'invocation'], class: 'write' }));
  assert.deepEqual(tools.list(), [
    { name: 'z', description: 'A tool.', inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: 'a', description: 'A tool.', inputSchema: { type: 'object', properties: {} } },
    { name: 'm', description: 'A tool.', inputSchema: { type: 'object', properties: {} } },
  ]);
  assert.equal(tools.list()[0].inputSchema, schema);
  assert.deepEqual(Object.keys(tools.list()[1]), ['name', 'description', 'inputSchema']);
  assert.deepEqual(tools.list((condition) => condition === 'comms').map(({ name }) => name), ['z', 'a']);
  assert.deepEqual(tools.list(() => false).map(({ name }) => name), ['z']);
});

test('agent-bot mcp: the member tools equal the README table, in order', () => {
  assert.equal(MEMBER_TOOLS.server, 'agent-bot');
  assert.deepEqual(MEMBER_TOOLS.entries().map((entry) => [entry.name, entry.class]),
    readmeTable('`tests/tool-registry.test.mjs` keeps this table equal to\nthe registry, in its order'));
  assert.throws(() => MEMBER_TOOLS.register(tool({ name: 'late' })), /registration is closed/);
});

// The classes agent-mcp.mjs's TOOL_CLASS table gave before the registry.
// Its other names (the meta tools) were never in the table: they are the
// server's own, not registered.
const CLASSES_BEFORE = {
  whoami: 'read', population: 'read', space_path: 'read', peek_notices: 'read',
  doctor: 'read', server_status: 'read', guide: 'read',
  bind: 'write', credential: 'write', take_notices: 'write', ack_notices: 'write',
  release_notices: 'write', take_inbox: 'write', request_grant: 'write', spend_grant: 'write',
  machine_status: 'read', machine_receipts: 'read',
  machine_plan: 'write', machine_apply: 'write', machine_update: 'write',
};

test('agent-bot mcp: every member tool keeps the class it had', () => {
  assert.deepEqual(Object.fromEntries(MEMBER_TOOLS.entries().map((entry) => [entry.name, entry.class])), CLASSES_BEFORE);
  assert.deepEqual(MEMBER_TOOLS.entries().map((entry) => entry.when), MEMBER_TOOLS.names().map(() => []));
});

test('agent-reach: the reach tools equal the README table, in order', () => {
  assert.equal(REACH_TOOLS.server, 'agent-reach');
  assert.deepEqual(REACH_TOOLS.entries().map((entry) => [entry.name, entry.class, entry.when.join(', ') || 'always']),
    readmeTable('`tests/tool-registry.test.mjs` keeps this table equal to the registry, in the\norder `tools/list` shows them'));
  assert.throws(() => REACH_TOOLS.register(tool({ name: 'late' })), /registration is closed/);
});

test('agent-reach: the names, and the comms and invocation sets, are the ones it had', () => {
  assert.deepEqual(REACH_TOOL_NAMES, ['fetch_context', 'post_reply', 'report_status', 'clock_in', 'fleet', 'send_message', 'start_soul']);
  assert.ok(Object.isFrozen(REACH_TOOL_NAMES));
  const withCondition = (condition) => REACH_TOOLS.entries().filter((entry) => entry.when.includes(condition)).map((entry) => entry.name);
  assert.deepEqual(withCondition('comms'), ['fleet', 'send_message', 'start_soul']);
  assert.deepEqual(withCondition('invocation'), ['fetch_context', 'post_reply', 'report_status']);
});
