const CAPABILITY_COLLECTION = 'collection';

const REQUIRED_COLLECTION_METHODS = [
  'setCredentials',
  'testConnection',
  'submitCollection',
  'getJobState',
  'getJobResults',
  'getJobHistory'
];

const APPROVED_METADATA_FIELDS = [
  'providerId',
  'displayName',
  'capabilities',
  'enabled',
  'configuration',
  'credentials',
  'status'
];

function invalidParams(message) {
  const err = new Error(message);
  err.invalidParams = true;
  return err;
}

function assertCollectionProvider(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw invalidParams('Invalid provider adapter (object required)');
  }
  if (typeof adapter.providerId !== 'string' || !adapter.providerId) {
    throw invalidParams('Invalid provider adapter (providerId required)');
  }
  if (typeof adapter.displayName !== 'string' || !adapter.displayName) {
    throw invalidParams('Invalid provider adapter (displayName required)');
  }
  if (!Array.isArray(adapter.capabilities) || !adapter.capabilities.includes(CAPABILITY_COLLECTION)) {
    throw invalidParams('Invalid provider adapter (collection capability required)');
  }
  if (typeof adapter.enabled !== 'boolean') {
    throw invalidParams('Invalid provider adapter (enabled required)');
  }
  if (!adapter.configuration || typeof adapter.configuration !== 'object' || Array.isArray(adapter.configuration)) {
    throw invalidParams('Invalid provider adapter (configuration required)');
  }
  for (const method of REQUIRED_COLLECTION_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw invalidParams(`Invalid provider adapter (${method} required)`);
    }
  }
  return adapter;
}

module.exports = {
  CAPABILITY_COLLECTION,
  REQUIRED_COLLECTION_METHODS,
  APPROVED_METADATA_FIELDS,
  invalidParams,
  assertCollectionProvider
};
