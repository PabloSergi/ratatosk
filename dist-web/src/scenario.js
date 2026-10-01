/**
 * The scenario is the artifact the model produces once, at build time.
 * Everything after that runs from this file alone, with no model involved.
 * It is plain JSON on purpose: a human must be able to read it and fix a selector by hand.
 */
export class ScenarioError extends Error {
}
/** Parse and validate in one step — a scenario is only ever used after this. Callers get one error type. */
export function parseScenario(raw) {
    const data = typeof raw === 'string' ? parseJson(raw) : raw;
    if (!isRecord(data))
        throw new ScenarioError('scenario must be an object');
    const name = req(data, 'name', 'string');
    const url = req(data, 'url', 'string');
    if (data['version'] !== 1)
        throw new ScenarioError(`${name}: unsupported version, expected 1`);
    if (!/^https?:\/\//.test(url))
        throw new ScenarioError(`${name}: url must be http(s)`);
    const wait = data['wait'];
    if (!isRecord(wait))
        throw new ScenarioError(`${name}: wait rule is required`);
    req(wait, 'selector', 'string');
    const list = data['list'];
    if (!isRecord(list))
        throw new ScenarioError(`${name}: list rule is required`);
    req(list, 'rows', 'string');
    const fields = list['fields'];
    if (!isRecord(fields) || Object.keys(fields).length === 0) {
        throw new ScenarioError(`${name}: list.fields must name at least one field`);
    }
    for (const [field, rule] of Object.entries(fields)) {
        if (!isRecord(rule))
            throw new ScenarioError(`${name}: field ${field} must be an object`);
        const type = rule['type'];
        if (type !== 'text' && type !== 'attr' && type !== 'html') {
            throw new ScenarioError(`${name}: field ${field} has unknown type ${String(type)}`);
        }
        if (type === 'attr' && typeof rule['attr'] !== 'string') {
            throw new ScenarioError(`${name}: field ${field} is an attr field but names no attribute`);
        }
    }
    const detail = data['detail'];
    if (detail !== undefined) {
        if (!isRecord(detail))
            throw new ScenarioError(`${name}: detail must be an object`);
        if (typeof detail['follow'] !== 'string')
            throw new ScenarioError(`${name}: detail.follow must name a column`);
        const detailFields = detail['fields'];
        if (!isRecord(detailFields) || Object.keys(detailFields).length === 0) {
            throw new ScenarioError(`${name}: detail.fields must name at least one field`);
        }
        if (fields[detail['follow']] === undefined) {
            throw new ScenarioError(`${name}: detail.follow names "${String(detail['follow'])}", which the list does not collect`);
        }
    }
    const pagination = data['pagination'];
    if (!isRecord(pagination))
        throw new ScenarioError(`${name}: pagination is required, use {"type":"none"}`);
    if (pagination['type'] === 'number' && !pagination['param'] && !pagination['path']) {
        throw new ScenarioError(`${name}: a numbered pager needs to know where the number goes — "param" or "path"`);
    }
    if (typeof pagination['path'] === 'string' && !pagination['path'].includes('{n}')) {
        throw new ScenarioError(`${name}: pagination path must say where the number goes, as {n} — e.g. "/p{n}"`);
    }
    const expect = isRecord(data['expect']) ? data['expect'] : {};
    return {
        ...data,
        wait: {
            selector: wait['selector'],
            minCount: numberOr(wait['minCount'], 1),
            timeoutMs: numberOr(wait['timeoutMs'], 15_000),
            settleMs: numberOr(wait['settleMs'], 2_000),
        },
        expect: { minRowsPerPage: numberOr(expect['minRowsPerPage'], 1) },
        ...(isRecord(detail)
            ? {
                detail: {
                    follow: detail['follow'],
                    fields: detail['fields'],
                    maxRows: numberOr(detail['maxRows'], 40),
                    ...(detail['waitMs'] !== undefined ? { waitMs: numberOr(detail['waitMs'], 8000) } : {}),
                },
            }
            : {}),
    };
}
function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function parseJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new ScenarioError(`scenario is not valid JSON: ${error.message}`);
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function req(data, key, type) {
    const value = data[key];
    if (typeof value !== type)
        throw new ScenarioError(`${key} is required and must be a ${type}`);
    return value;
}
