const { logger } = require('../logger');
const { CoreClawClient } = require('../coreClawClient');
const { CAPABILITY_COLLECTION, invalidParams } = require('./collectionProvider');

const ALLOWED_LANGS = new Set(['en', 'zh', 'es', 'fr', 'de', 'ar', 'pt', 'ja', 'ko']);
const ALLOWED_TITLE_MATCH_MODES = new Set(['all', 'exact', 'contains']);
const ALLOWED_MIN_RATINGS = new Set(['all', '4.5', '4.0', '3.5', '3.0']);
const ALLOWED_WEBSITE_FILTERS = new Set(['all', 'has_website', 'no_website']);
const ALLOWED_REVIEW_SORTS = new Set(['newest', 'highest', 'lowest', 'most_relevant']);
const COLLECT_BOOL_KEYS = [
  'skipClosed', 'fetchSocialInfo', 'facebook', 'instagram', 'youtube', 'tiktok',
  'linkedin', 'fetchPlaceDetails', 'fetchReservation', 'fetchOnlineOrder',
  'fetchWebResult', 'emailVerification', 'fetchReviews', 'includeReviewerInfo'
];
const RUN_SLUG_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;

function assertOptionalString(value, name, maxLength) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw invalidParams(`Invalid params: ${name} (string required)`);
  if (value.length > maxLength) throw invalidParams(`Invalid params: ${name} (max ${maxLength} chars)`);
}

function assertOptionalEnum(value, name, allowed) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw invalidParams(`Invalid params: ${name}`);
  }
}

function assertOptionalInt(value, name, min, max) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidParams(`Invalid params: ${name} (integer ${min}-${max})`);
  }
}

function validateSubmitParams(params) {
  assertOptionalString(params.location, 'location', 200);
  assertOptionalEnum(params.lang, 'lang', ALLOWED_LANGS);
  assertOptionalInt(params.maxResults, 'maxResults', 1, 500);
  assertOptionalEnum(params.titleMatchMode, 'titleMatchMode', ALLOWED_TITLE_MATCH_MODES);
  assertOptionalEnum(params.minRating, 'minRating', ALLOWED_MIN_RATINGS);
  assertOptionalEnum(params.websiteFilter, 'websiteFilter', ALLOWED_WEBSITE_FILTERS);
  assertOptionalEnum(params.reviewSortBy, 'reviewSortBy', ALLOWED_REVIEW_SORTS);
  assertOptionalInt(params.maxReviewsPerPlace, 'maxReviewsPerPlace', 1, 50);
  assertOptionalString(params.reviewKeyword, 'reviewKeyword', 200);

  for (const key of COLLECT_BOOL_KEYS) {
    if (params[key] !== undefined && params[key] !== null) {
      params[key] = params[key] === true;
    }
  }

  return params;
}

function validateJobId(jobId) {
  if (typeof jobId !== 'string' || !RUN_SLUG_PATTERN.test(jobId)) {
    throw invalidParams('Invalid params: runSlug');
  }
  return jobId;
}

class CoreClawAdapter {
  constructor() {
    this.providerId = 'coreclaw';
    this.displayName = 'CoreClaw';
    this.capabilities = [CAPABILITY_COLLECTION];
    this.enabled = true;
    this.configuration = {};
    this.client = new CoreClawClient();
  }

  setCredentials(credentials) {
    const apiKey = credentials && typeof credentials === 'object' ? credentials.apiKey : undefined;
    this.client.setApiKey(typeof apiKey === 'string' ? apiKey : '');
  }

  async testConnection({ apiKey, taskKey }) {
    const testClient = new CoreClawClient();
    testClient.setApiKey(apiKey);

    const result = await testClient.getWorkerInputSchema();
    if (!result.success) {
      logger.info('coreclaw', 'connection test failed', { apiKeyValid: false, hasTaskKey: !!taskKey, error: result.error });
      return { success: false, error: 'API Key 无效或网络错误: ' + result.error };
    }
    let taskKeyValid = false;
    if (taskKey) {
      const runs = await testClient.request('GET', `/api/v2/worker-runs?task_key=${encodeURIComponent(taskKey)}`);
      taskKeyValid = runs.success;
    }
    logger.info('coreclaw', 'connection test succeeded', { apiKeyValid: true, taskKeyValid, hasTaskKey: !!taskKey });
    return { success: true, apiKeyValid: true, taskKeyValid };
  }

  async submitCollection(params) {
    const validated = validateSubmitParams(params);
    return this.client.runGoogleMaps(validated);
  }

  async getJobState(jobId) {
    validateJobId(jobId);
    return this.client.getRunStatus(jobId);
  }

  async getJobResults(jobId, options) {
    validateJobId(jobId);
    const opts = (options && typeof options === 'object') ? options : {};
    const offset = opts.offset === undefined ? 0 : opts.offset;
    const limit = opts.limit === undefined ? 100 : opts.limit;
    return this.client.getRunResult(jobId, offset, limit);
  }

  async getJobHistory(paging) {
    const p = (paging && typeof paging === 'object') ? paging : {};
    const limit = p.limit === undefined ? 20 : p.limit;
    const offset = p.offset === undefined ? 0 : p.offset;
    return this.client.getRunHistory(limit, offset);
  }

  async getStore() {
    return this.client.getStore();
  }

  async abortJob(jobId) {
    validateJobId(jobId);
    return this.client.abortRun(jobId);
  }
}

module.exports = { CoreClawAdapter, validateSubmitParams, validateJobId };
