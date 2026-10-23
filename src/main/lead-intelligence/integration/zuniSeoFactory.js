'use strict';

const { ZuniSeoProvider } = require('../providers/ZuniSeoProvider');
const { McpTransport } = require('../providers/transports/McpTransport');
const { RestTransport } = require('../providers/transports/RestTransport');
const { ArtifactImporter } = require('../providers/transports/ArtifactImporter');
const { FakeResearchProvider } = require('../providers/FakeResearchProvider');
const { validateServiceBaseUrl } = require('../core/urls');
const { assertProvider } = require('../providers/ProspectResearchProvider');

/**
 * Builds the provider registry used by the coordinator. Runs in the MAIN process only.
 *
 * Credentials: `credentialStore.get(name)` must return the decrypted secret on demand
 * (SafeStorage-backed). INTEGRATION POINT: round 1 added SafeStorageCredentialStore in
 * the ztech-prospect-research bundle — reuse it; do not create a second credential store.
 * Round-1's ZuniSeoCredentialSource exposes getApiKey() with no argument (Step 0 #5), so
 * adapt it as: const credentialStore = { get: async () => credentialSource.getApiKey() };
 *
 * MCP client (INTEGRATION POINT, module mode only — in round1 mode round-1's own client is
 * used and this factory is not needed): `createMcpClient({ url, headers })` must return a
 * connected MCP client with callTool({name, arguments}) and close().
 * The package installed in ZTech is `@modelcontextprotocol/client` v2.1.0 (verified in
 * Step 0 #6) — NOT `@modelcontextprotocol/sdk`. VERIFY its exported client class and
 * Streamable-HTTP transport names in node_modules/@modelcontextprotocol/client/package.json
 * ("exports") before writing createMcpClient; do not guess import paths.
 */
function buildResearchProviders({ config, credentialStore, createMcpClient, fetchImpl = globalThis.fetch, readFile, stat }) {
  const providers = new Map();
  const research = (config && config.research) || {};
  const z = research.zuniSeo || {};

  if (z.enabled !== false && z.transport) {
    const getToken = async () => (credentialStore ? credentialStore.get(z.credentialName || 'zuni-seo-api-key') : null);
    let transport;
    if (z.transport === 'mcp') {
      const v = validateServiceBaseUrl(z.mcpUrl, { allowLocalhost: Boolean(z.allowLocalhost) });
      if (!v.ok) throw new Error(`research.zuniSeo.mcpUrl is not allowed (${v.reason})`);
      if (typeof createMcpClient !== 'function') throw new Error('createMcpClient is required for the MCP transport');
      transport = new McpTransport({
        connect: async () => {
          const token = await getToken();
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          return createMcpClient({ url: v.base, headers });
        },
        toolNames: z.mcpToolNames,
        argNames: z.mcpArgNames,
        timeoutMs: z.timeoutMs,
      });
    } else if (z.transport === 'rest') {
      transport = new RestTransport({
        baseUrl: z.restBaseUrl,
        getToken,
        fetchImpl,
        allowLocalhost: Boolean(z.allowLocalhost),
        paths: z.restPaths,
        timeoutMs: z.timeoutMs,
      });
    } else {
      throw new Error(`Unknown research.zuniSeo.transport "${z.transport}" (expected "mcp" or "rest")`);
    }
    providers.set('zuni-seo', assertProvider(new ZuniSeoProvider({ transport, id: 'zuni-seo', name: 'Zuni-SEO' })));
  }

  if (research.enableArtifactImport !== false) {
    const importer = new ArtifactImporter({ ...(readFile ? { readFile } : {}), ...(stat ? { stat } : {}) });
    providers.set('zuni-seo-artifact', assertProvider(new ZuniSeoProvider({ transport: importer, id: 'zuni-seo-artifact', name: 'Zuni-SEO (imported file)' })));
  }

  if (research.enableFakeProvider === true) {
    providers.set('fake', assertProvider(new FakeResearchProvider()));
  }

  return providers;
}

module.exports = { buildResearchProviders };
