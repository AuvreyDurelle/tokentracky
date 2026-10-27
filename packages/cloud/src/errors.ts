export class CloudError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}
export function invalid(message = 'Invalid request'): never {
  throw new CloudError(400, 'INVALID_REQUEST', message);
}
/** A database aggregate as a number, refused when it is not a safe nonnegative integer. */
export const safe = (value: string | number): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new CloudError(422, 'COUNTER_OVERFLOW', 'Aggregate exceeds the safe integer range');
  return result;
};
