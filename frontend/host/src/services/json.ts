// Narrowing predicate for JSON object bodies. Arrays are deliberately excluded:
// every caller wants "a record of fields", and an array body should fail
// validation rather than pass and then fail on a missing field.
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

// Validity predicate for JSON string fields. Empty strings count as absent: they
// carry no information and would otherwise render as an empty toast or miss a
// lookup table and fall through to a generic message.
export const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0;
};
