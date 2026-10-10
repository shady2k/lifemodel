export const INSTANCE_ADDED_CAPABILITY = 'CAP_NET_ADMIN';

export function hasOnlyInstanceAddedCapability(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length === 1 &&
    value[0] === INSTANCE_ADDED_CAPABILITY;
}
