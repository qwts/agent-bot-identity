// The MCP tool registry (tool-registry.mjs, #1394; HQ plan Stage 0 row 9).
// Both MCP servers register each tool once, with its schema, class, handler
// and listing conditions. This file checks the registry refuses what it does
// not know and lists what it holds in order.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry, TOOL_CLASSES } from '../tool-registry.mjs';

const handler = () => ({});
const tool = (overrides = {}) => ({
  name: 't', description: 'A tool.', inputSchema: { type: 'object', properties: {} }, class: 'read', handler, ...overrides,
});

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
