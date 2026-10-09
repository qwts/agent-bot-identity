// Environment names a relayed turn carries between the daemon, the reach MCP
// server and a resumed harness. Constants only, so the soul side can set what
// the host side reads without importing the host (#645).

// The thread a relayed turn belongs to (#392): the woken message's
// correlation, or its id. send_message and start_soul's brief carry it, so a
// teammate's answer finds its way back into this soul's thread.
export const REACH_CORRELATION_ENV = 'AGENT_BOT_REACH_CORRELATION';
