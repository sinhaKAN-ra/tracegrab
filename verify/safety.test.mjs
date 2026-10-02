/**
 * Tests for the pure safety modules: entitlements (feature flags / tiers) and
 * secret redaction. Run: node verify/safety.test.mjs (compiles the TS first).
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
execSync(
    `npx --yes tsc "${path.join(root, 'src', 'entitlements.ts')}" "${path.join(root, 'src', 'redact.ts')}" ` +
    `--outDir "${outDir}" --module esnext --target es2022 --moduleResolution bundler`,
    { stdio: 'pipe' }
);
const ent = await import(path.join(outDir, 'entitlements.js'));
const red = await import(path.join(outDir, 'redact.js'));

let pass = 0, fail = 0;
const assert = (c, m) => (c ? (pass++, console.log(`\u2713 ${m}`)) : (fail++, console.error(`\u2717 FAIL: ${m}`)));

// ---- entitlements ----
assert(ent.resolveTier(null) === 'free', 'no license → free');
assert(ent.resolveTier({ tier: 'pro' }) === 'pro', 'pro license → pro');
assert(ent.resolveTier({ tier: 'pro', expires: '2000-01-01' }) === 'free', 'expired license → free');
assert(ent.isEnabled('core.debug', 'free') === true, 'free tier gets core.debug');
assert(ent.isEnabled('trace.compare', 'free') === false, 'free tier does NOT get trace.compare');
assert(ent.isEnabled('trace.compare', 'pro') === true, 'pro tier gets trace.compare');
assert(ent.isEnabled('ci.runner', 'pro') === false, 'pro tier does NOT get ci.runner (team)');
assert(ent.isEnabled('ci.runner', 'team') === true, 'team tier gets ci.runner');
{
  const g = ent.gate('contracts', 'free');
  assert(g.allowed === false && g.requiredTier === 'pro' && /pro plan/.test(g.message), 'gate() denies + explains upgrade');
  const u = ent.gate('contracts', 'free', true);
  assert(u.allowed === true && u.unlockedByEnv === true, 'FLOW_UNLOCK_ALL override unlocks');
}

// ---- redaction ----
assert(red.isSecretName('apiKey') && red.isSecretName('user_password') && red.isSecretName('AUTH_TOKEN'), 'secret names detected');
assert(!red.isSecretName('userId') && !red.isSecretName('count'), 'ordinary names not flagged');
assert(red.isSecretValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'), 'JWT value detected');
assert(red.isSecretValue('AKIAIOSFODNN7EXAMPLE'), 'AWS key value detected');
assert(!red.isSecretValue('U7') && !red.isSecretValue('VERIFIED'), 'short ordinary values not flagged');
assert(red.redactValue('token', "'abc123secretlong'").redacted === true, 'value under a secret name is redacted');
assert(red.redactValue('token', 'undefined').redacted === false, 'empty/undefined secret NOT redacted (stays debuggable)');
assert(red.redactValue('userId', "'U7'").redacted === false, 'ordinary var passes through');
{
  const out = red.redactVars([{ name: 'password', value: "'hunter2'", variablesReference: 5 }, { name: 'id', value: "'U7'", variablesReference: 0 }]);
  assert(out[0].value === red.REDACTION_PLACEHOLDER && out[0].variablesReference === 0, 'redacted var masked + made non-expandable');
  assert(out[1].value === "'U7'", 'non-secret var untouched');
}

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
