export function normalizeStateVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

export function normalizeUpdatedAt(value) {
  if (typeof value !== 'string' || !value.trim()) return new Date(0).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export function withStateMetadata(state, source = state) {
  return {
    version: normalizeStateVersion(source?.version),
    updatedAt: normalizeUpdatedAt(source?.updatedAt),
    shifts: Array.isArray(state?.shifts) ? state.shifts : [],
    applications: Array.isArray(state?.applications) ? state.applications : [],
    inviteGroups: Array.isArray(state?.inviteGroups) ? state.inviteGroups : []
  };
}

export function normalizeBookingState(state) {
  return withStateMetadata({
    shifts: Array.isArray(state?.shifts) ? state.shifts : [],
    applications: Array.isArray(state?.applications) ? state.applications : [],
    inviteGroups: Array.isArray(state?.inviteGroups) ? state.inviteGroups : []
  }, state);
}
