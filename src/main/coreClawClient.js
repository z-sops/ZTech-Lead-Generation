const { logger } = require('./logger');

const BASE_URL = 'https://openapi.coreclaw.com';
const DEFAULT_WORKER = 'coreclaw~google-maps-scraper';
const REQUEST_TIMEOUT_MS = 30000;

let netFetch = null;
try {
  const electron = require('electron');
  if (electron && electron.net && typeof electron.net.fetch === 'function') {
    netFetch = electron.net.fetch.bind(electron.net);
  }
} catch {
  netFetch = null;
}

class CoreClawClient {
  constructor() {
    this.apiKey = '';
    this.workerId = DEFAULT_WORKER;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  async request(method, path, body = null) {
    if (!this.apiKey) {
      return { success: false, error: '未设置 API Key' };
    }

    const url = `${BASE_URL}${path}`;

    try {
      const response = await (netFetch || fetch)(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      const data = await response.json();

      if (data.code !== 0) {
        return { success: false, error: data.message || '请求失败', raw: data };
      }

      return { success: true, data: data.data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async getStore() {
    const res = await this.request('GET', '/api/v2/store');
    if (!res.success) {
      logger.warn('coreclaw', 'store fetch failed', { error: res.error });
    }
    return res;
  }

  async getWorkerInputSchema(workerId) {
    const id = workerId || this.workerId;
    return this.request('GET', `/api/v2/workers/${encodeURIComponent(id)}/input-schema`);
  }

  async runGoogleMaps(params) {
    const {
      keywords, location, lang = 'en', maxResults = 20,
      titleMatchMode = 'all', minRating = 'all', websiteFilter = 'all',
      skipClosed = false, fetchSocialInfo = true,
      facebook = false, instagram = false, youtube = false,
      tiktok = false, linkedin = false,
      fetchPlaceDetails = false, fetchReservation = false,
      fetchOnlineOrder = false, fetchWebResult = false,
      emailVerification = false, fetchReviews = false,
      maxReviewsPerPlace = 5, reviewSortBy = 'newest',
      reviewKeyword = '', includeReviewerInfo = false
    } = params;

    const body = {
      input: {
        parameters: {
          custom: {
            keywords: keywords.map(k => ({ keyword: k })),
            base_location: location,
            lang,
            max_results: maxResults,
            place_categories: [],
            title_match_mode: titleMatchMode,
            min_rating: minRating,
            website_filter: websiteFilter,
            skip_permanently_closed: skipClosed,
            fetch_social_info: fetchSocialInfo,
            facebook,
            instagram,
            youtube,
            tiktok,
            linkedin,
            fetch_place_details: fetchPlaceDetails,
            fetch_reservation_data: fetchReservation,
            fetch_online_order: fetchOnlineOrder,
            fetch_web_result: fetchWebResult,
            email_verification: emailVerification,
            fetch_reviews: fetchReviews,
            max_reviews_per_place: maxReviewsPerPlace,
            review_sort_by: reviewSortBy,
            review_keyword: reviewKeyword,
            include_reviewer_info: includeReviewerInfo,
            country: '',
            state: '',
            city: '',
            county: '',
            postal_code: '',
            custom_geojson: ''
          }
        }
      },
      is_async: true
    };
    const res = await this.request('POST', `/api/v2/workers/${encodeURIComponent(this.workerId)}/runs`, body);
    if (res.success) {
      logger.info('coreclaw', 'run submitted', { runSlug: res.data && res.data.run_slug, workerId: this.workerId });
    } else {
      logger.error('coreclaw', 'run submit failed', { error: res.error });
    }
    return res;
  }

  async getRunStatus(runSlug) {
    const res = await this.request('GET', `/api/v2/worker-runs/${encodeURIComponent(runSlug)}`);
    if (!res.success) {
      logger.warn('coreclaw', 'run status query failed', { runSlug, error: res.error });
    }
    return res;
  }

  async getRunResult(runSlug, offset = 0, limit = 100) {
    const res = await this.request('GET', `/api/v2/worker-runs/${encodeURIComponent(runSlug)}/result?offset=${offset}&limit=${limit}`);
    if (res.success) {
      logger.info('coreclaw', 'run result fetched', { runSlug, offset, limit });
    } else {
      logger.warn('coreclaw', 'run result fetch failed', { runSlug, error: res.error });
    }
    return res;
  }

  async getRunHistory(limit = 20, offset = 0) {
    const res = await this.request('GET', `/api/v2/worker-runs?limit=${limit}&offset=${offset}`);
    if (res.success) {
      logger.info('coreclaw', 'run history fetched', { limit, offset });
    } else {
      logger.warn('coreclaw', 'run history fetch failed', { limit, offset, error: res.error });
    }
    return res;
  }
}

module.exports = { CoreClawClient };
