/**
 * Secret redaction — mask credential-shaped names and values before ANY runtime
 * value reaches an agent (inspector, pause state, call map, evaluate, reports).
 *
 * Rules, matching the posture of Microsoft DebugMCP and mcp-debugger:
 *  - Redact by VARIABLE NAME (token, apiKey, password, …).
 *  - Redact by VALUE SHAPE (JWT, AWS key, bearer, PEM, long hex/base64).
 *  - NEVER redact null/undefined/'' — "my token is empty" must stay debuggable.
 *  - Off switch: FLOW_NO_REDACT=1 (checked by the caller, not here).
 *
 * Pure + dependency-free so it is unit-testable and reusable by the MCP server.
 */

const REDACTED = '<redacted: possible secret>';

const NAME_RE = /(pass(word|wd)?|secret|token|api[_-]?key|auth(orization)?|cookie|credential|priv(ate)?[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id)/i;

const VALUE_RES: RegExp[] = [
    /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
    /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
    /\bASIA[0-9A-Z]{16}\b/, // AWS temp key id
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i, // bearer token
    /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
];

/** A value that is empty/nullish — never a secret worth hiding. */
function isEmptyish(value: string): boolean {
    const t = value.trim().replace(/^['"]|['"]$/g, '');
    return t === '' || t === 'null' || t === 'undefined' || t === 'None' || t === '[]' || t === '{}';
}

/** True if the NAME looks credential-bearing. */
export function isSecretName(name: string): boolean {
    return NAME_RE.test(name);
}

/** True if the VALUE looks like a credential. */
export function isSecretValue(value: string): boolean {
    if (isEmptyish(value)) return false;
    const v = value.replace(/^['"]|['"]$/g, '');
    if (VALUE_RES.some((re) => re.test(v))) return true;
    // Long high-entropy-ish opaque blobs (hex/base64) — but not short ids.
    if (/^[A-Fa-f0-9]{40,}$/.test(v)) return true;
    if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(v)) return true;
    return false;
}

/** Redact one value given its variable name. Empty stays visible. */
export function redactValue(name: string, value: string): { value: string; redacted: boolean } {
    if (isEmptyish(value)) return { value, redacted: false };
    if (isSecretName(name) || isSecretValue(value)) return { value: REDACTED, redacted: true };
    return { value, redacted: false };
}

export interface VarLike {
    name: string;
    value: string;
    type?: string;
    variablesReference?: number;
    [k: string]: unknown;
}

/** Redact a list of variables in place-safe (returns new objects). */
export function redactVars<T extends VarLike>(vars: T[]): T[] {
    return vars.map((v) => {
        const r = redactValue(v.name, String(v.value));
        return r.redacted ? { ...v, value: r.value, variablesReference: 0 } : v;
    });
}

export const REDACTION_PLACEHOLDER = REDACTED;
