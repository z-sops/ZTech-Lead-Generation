'use strict';

/**
 * Phase 2: real business opportunity intelligence (P03-P08, P15 data).
 * Pure logic; every network call goes through an injected transport.
 */
module.exports = {
  criteria: require('./criteria'),
  html: require('./html'),
  robots: require('./robots'),
  checks: require('./checks'),
  inspector: require('./inspector'),
  discovery: require('./discovery'),
  scoring: require('./scoring'),
  pipeline: require('./pipeline'),
  proposal: require('./proposal'),
  adsDiff: require('./adsDiff'),
  contacts: require('./contacts'),
  enrich: require('./enrich'),
};
