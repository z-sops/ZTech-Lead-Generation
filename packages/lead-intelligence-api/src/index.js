'use strict';

/**
 * @zunitech/lead-intelligence-api
 *
 * The HTTP service: authentication, organizations, memberships, invitations,
 * and the role-based authorization over the tenant boundary.
 *
 * The service decides WHICH workspace a request is for. The database decides
 * WHETHER that claim is well-formed, current and effective: the workspace
 * token is bound to a session and a user, and the database re-checks the
 * session's entitlement on every read.
 */

const { ApiServer, SESSION_COOKIE, CSRF_HEADER } = require('./server');
const { AuthService, ServiceError } = require('./service');
const security = require('./security');

module.exports = { ApiServer, AuthService, ServiceError, SESSION_COOKIE, CSRF_HEADER, ...security };