// Display risk only; permission policy remains the authority to execute.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead', 'Task', 'Agent']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'terminal', 'execute', 'shell']);
const COMPUTER_TOOLS = new Set([
  'computer', 'computer_use', 'computer-use', 'screenshot', 'left_click', 'right_click',
  'double_click', 'type', 'key', 'scroll', 'mouse_move', 'left_click_drag', 'open_application',
]);
const DESTRUCTIVE = /\brm\s+-[^\s]*r|\bgit\s+push\b[^\n;]*\s(?:--force(?:-with-lease)?|-f)\b|\bgit\s+reset\b[^\n;]*--hard\b|\bgit\s+clean\b|\bgit\s+branch\b[^\n;]*\s-D\b|\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\b|\bVACUUM\s+FULL\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkill\s+-9\b|\blaunchctl\s+unload\b|\bdefaults\s+write\b|\b(?:chmod|chown)\s+-R\b|>\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|fd\/)|:\(\)\s*\{/i;

function toolSegment(toolName) {
  return toolName.replace(/^mcp__.+?__/, '');
}

export function isComputerUse(toolName) {
  return typeof toolName === 'string' && (
    toolName.startsWith('mcp__computer-use__')
    || toolName.startsWith('mcp__remote-devices__computer_')
    || COMPUTER_TOOLS.has(toolSegment(toolName))
  );
}

export function classifyRisk(input) {
  if (!input || typeof input !== 'object') return 'external';
  const { toolName, summary, operation } = input;
  if (typeof toolName !== 'string' || !toolName) return 'external';
  // A computer-use server can expose read-like names while using the screen.
  if (isComputerUse(toolName)) return 'external';
  const tool = toolSegment(toolName);
  if (READ_TOOLS.has(tool) || (toolName.startsWith('mcp__') && /^(?:get_|list_|read_|search_|fetch_context)/.test(tool))) return 'safe';
  if (WRITE_TOOLS.has(toolName)) return 'safe';
  if (!SHELL_TOOLS.has(toolName)) return 'external';
  let operationText = '';
  try { operationText = typeof operation === 'string' ? operation : JSON.stringify(operation) ?? ''; }
  catch { return 'external'; }
  const text = [typeof summary === 'string' ? summary : '', operationText].join('\n').slice(0, 2000);
  return DESTRUCTIVE.test(text) ? 'destructive' : 'external';
}
