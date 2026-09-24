const LEGACY_SETTINGS_KEY = 'settings';
const PROVIDERS_KEY = 'providers';
const LEGACY_CREDENTIAL_FIELDS = ['apiKey', 'taskKey'];

function migrateLegacySettingsToProviders(store, providerId) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    return { migrated: false };
  }
  if (typeof providerId !== 'string' || !providerId) {
    return { migrated: false };
  }
  const legacy = store.get(LEGACY_SETTINGS_KEY, null);
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return { migrated: false };
  }
  const hasLegacyCredential = LEGACY_CREDENTIAL_FIELDS.some(
    field => typeof legacy[field] === 'string' && legacy[field].length > 0
  );
  if (!hasLegacyCredential) {
    return { migrated: false };
  }
  const providers = store.get(PROVIDERS_KEY, null);
  const existingRecord = providers && typeof providers === 'object' ? providers[providerId] : null;
  if (existingRecord && existingRecord.credentials && typeof existingRecord.credentials === 'object') {
    return { migrated: false };
  }
  const credentials = {};
  for (const field of LEGACY_CREDENTIAL_FIELDS) {
    credentials[field] = typeof legacy[field] === 'string' ? legacy[field] : '';
  }
  const record = {
    ...(existingRecord && typeof existingRecord === 'object' ? existingRecord : {}),
    providerId,
    enabled: existingRecord && existingRecord.enabled !== undefined ? existingRecord.enabled : true,
    configuration:
      existingRecord && existingRecord.configuration && typeof existingRecord.configuration === 'object'
        ? existingRecord.configuration
        : {},
    credentials
  };
  store.set(PROVIDERS_KEY, {
    ...(providers && typeof providers === 'object' ? providers : {}),
    [providerId]: record
  });
  return { migrated: true };
}

module.exports = { migrateLegacySettingsToProviders };
