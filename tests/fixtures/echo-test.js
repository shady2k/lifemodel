#!/usr/bin/env node
/**
 * Echo Test Script — Phase 1 validation.
 *
 * Reads SCRIPT_INPUTS env var, outputs { echo: inputs.message } to stdout.
 * Used to verify the script mode container lifecycle end-to-end.
 */

'use strict';

const inputsRaw = process.env.SCRIPT_INPUTS;
if (!inputsRaw) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { code: 'INVALID_INPUT', message: 'SCRIPT_INPUTS env var not set' }
  }));
  process.exit(1);
}

let inputs;
try {
  inputs = JSON.parse(inputsRaw);
} catch (e) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { code: 'INVALID_INPUT', message: 'SCRIPT_INPUTS is not valid JSON' }
  }));
  process.exit(1);
}

if (typeof inputs.message !== 'string') {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { code: 'INVALID_INPUT', message: 'inputs.message must be a string' }
  }));
  process.exit(1);
}

// Success: echo the message back
process.stdout.write(JSON.stringify({ echo: inputs.message }));
process.exit(0);
