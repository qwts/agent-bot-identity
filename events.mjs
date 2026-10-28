#!/usr/bin/env node
// Moved to identity/events.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that run it here; it loads the moved file.
import './identity/events.mjs';
