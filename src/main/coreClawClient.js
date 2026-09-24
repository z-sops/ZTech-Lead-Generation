const BASE_URL = 'https://openapi.coreclaw.com';
const DEFAULT_WORKER = 'coreclaw~google-maps-scraper';

class CoreClawClient {
  constructor() {
    this.apiKey = '';
    this.workerId = DEFAULT_WORKER;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  setWorkerId(id) {
    this.workerId = id || DEFAULT_WORKER;
  }

  async request(method, path, body = null) {
    if (!this.apiKey) {
      return { success: false, error: '未设置 API Key' };
    }

    const url = `${BASE_URL}${path}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
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
    return this.request('GET', '/api/v2/store');
  }

  async getWorkerInputSchema(workerId) {
    return this.request('GET', `/api/v2/workers/${workerId || this.workerId}/input-schema`);
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
    return this.request('POST', `/api/v2/workers/${this.workerId}/runs`, body);
  }

  async getRunStatus(runSlug) {
    return this.request('GET', `/api/v2/worker-runs/${runSlug}`);
  }

  async getRunResult(runSlug, offset = 0, limit = 100) {
    return this.request('GET', `/api/v2/worker-runs/${runSlug}/result?offset=${offset}&limit=${limit}`);
  }

  async abortRun(runSlug) {
    return this.request('POST', `/api/v2/worker-runs/${runSlug}/abort`);
  }

  async getRunHistory(limit = 20, offset = 0) {
    return this.request('GET', `/api/v2/worker-runs?limit=${limit}&offset=${offset}`);
  }

  isRunComplete(status) {
    return status === 'succeeded' || status === 'completed' || status === 'success';
  }

  isRunFailed(status) {
    return status === 'failed' || status === 'error';
  }
}

module.exports = { CoreClawClient };
