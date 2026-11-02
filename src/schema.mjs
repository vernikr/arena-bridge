function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  return actualType(value) === type;
}

/** Validate the shallow JSON schemas exposed by the tool catalog. */
export function validateArgs(schema, required = [], args) {
  if (!matchesType(args, 'object')) {
    return { ok: false, field: null, message: `arguments must be an object, got ${actualType(args)}` };
  }

  const properties = schema?.properties || {};
  for (const key of Object.keys(args)) {
    if (schema?.additionalProperties === false && !Object.hasOwn(properties, key)) {
      return { ok: false, field: key, message: `unknown argument: ${key}` };
    }
  }
  for (const key of required || []) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) {
      return { ok: false, field: key, message: `argument is required: ${key}` };
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!Object.hasOwn(args, key) || args[key] === undefined || !spec?.type) continue;
    if (!matchesType(args[key], spec.type)) {
      return { ok: false, field: key, message: `argument ${key} must be ${spec.type}, got ${actualType(args[key])}` };
    }
  }
  return { ok: true };
}
