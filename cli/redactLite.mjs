/**
 * Zero-dep secret redaction for the headless collector. Mirrors src/redact.ts —
 * values captured in CI must be masked before they touch disk or a PR comment.
 */
const REDACTED = '<redacted: possible secret>';
const NAME_RE = /(pass(word|wd)?|secret|token|api[_-]?key|auth(orization)?|cookie|credential|priv(ate)?[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id)/i;
const VALUE_RES = [
    /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bASIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

function isEmptyish(value) {
    const t = String(value).trim().replace(/^['"]|['"]$/g, '');
    return t === '' || t === 'null' || t === 'undefined' || t === 'None' || t === '[]' || t === '{}';
}

export function isSecretName(name) { return NAME_RE.test(String(name)); }

export function isSecretValue(value) {
    if (isEmptyish(value)) return false;
    const v = String(value).replace(/^['"]|['"]$/g, '');
    if (VALUE_RES.some((re) => re.test(v))) return true;
    if (/^[A-Fa-f0-9]{40,}$/.test(v)) return true;
    if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(v)) return true;
    return false;
}

export function redactValue(name, value) {
    if (isEmptyish(value)) return { value, redacted: false };
    if (isSecretName(name) || isSecretValue(value)) return { value: REDACTED, redacted: true };
    return { value, redacted: false };
}

export const REDACTION_PLACEHOLDER = REDACTED;
