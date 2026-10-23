'use strict';

// M0 compatibility shim.
//
// The implementation moved to the shared package @zunitech/lead-intelligence
// (packages/lead-intelligence/src/round1PacketMapper.js). This file re-exports it, so every
// existing require path - the desktop application, the tests, and the modules
// that stay behind - keeps working unchanged, and there is still exactly ONE
// implementation of the intelligence engine.
//
// Do not add logic here. Change the implementation in the package.

module.exports = require('../leadIntPackage').load('round1PacketMapper.js');
