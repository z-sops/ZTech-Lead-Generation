const { CAPABILITY_COLLECTION, APPROVED_METADATA_FIELDS, invalidParams, assertCollectionProvider } = require('./collectionProvider');

class ProviderManager {
  constructor() {
    this._adapters = new Map();
    this._credentials = new Map();
  }

  register(adapter) {
    assertCollectionProvider(adapter);
    this._adapters.set(adapter.providerId, adapter);
    if (!this._credentials.has(adapter.providerId)) {
      this._credentials.set(adapter.providerId, null);
    }
    return adapter;
  }

  getAdapter(providerId) {
    if (typeof providerId !== 'string' || !providerId) return null;
    return this._adapters.get(providerId) || null;
  }

  listProviders() {
    return [...this._adapters.values()].map(adapter => {
      const credentials = this._credentials.get(adapter.providerId) || null;
      const configured = !!credentials && Object.values(credentials).some(
        value => typeof value === 'string' && value.length > 0
      );
      const record = {
        providerId: adapter.providerId,
        displayName: adapter.displayName,
        capabilities: [...adapter.capabilities],
        enabled: adapter.enabled,
        configuration: { ...adapter.configuration },
        credentials,
        status: { configured }
      };
      for (const field of Object.keys(record)) {
        if (!APPROVED_METADATA_FIELDS.includes(field)) delete record[field];
      }
      return record;
    });
  }

  resolveCollectionProvider(providerId) {
    const available = [...this._adapters.values()].filter(
      adapter => adapter.enabled && adapter.capabilities.includes(CAPABILITY_COLLECTION)
    );
    if (providerId !== undefined && providerId !== null && providerId !== '') {
      const found = available.find(adapter => adapter.providerId === providerId);
      if (!found) {
        throw invalidParams('Invalid params: providerId (unknown or disabled provider)');
      }
      return found;
    }
    if (available.length === 1) return available[0];
    if (available.length === 0) {
      throw invalidParams('Invalid params: providerId (no collection provider available)');
    }
    throw invalidParams('Invalid params: providerId (providerId required)');
  }

  setCredentials(providerId, credentials) {
    const adapter = this.resolveCollectionProvider(providerId);
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw invalidParams('Invalid params: credentials (object required)');
    }
    const previous = this._credentials.get(adapter.providerId) || {};
    const merged = { ...previous, ...credentials };
    this._credentials.set(adapter.providerId, merged);
    adapter.setCredentials(merged);
    return merged;
  }

  getCredentials(providerId) {
    const adapter = this.resolveCollectionProvider(providerId);
    const credentials = this._credentials.get(adapter.providerId);
    return credentials ? { ...credentials } : null;
  }
}

module.exports = { ProviderManager };
