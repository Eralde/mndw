export const MAX_NODE_NAME = 64;

export interface NodeNameValidation {
  value: string | null;
  error: string | null;
}

export function validateNodeName(value: string): NodeNameValidation {
  const trimmed = value.trim();

  if (trimmed === '') {
    return {value: null, error: 'Name cannot be empty.'};
  }

  if (trimmed.length > MAX_NODE_NAME) {
    return {value: null, error: 'Name must be 64 characters or fewer.'};
  }

  return {value: trimmed, error: null};
}
