// The log-header mask must be in place before any Nightgate module logs.
require('./src/cap-log-mask-boot');
const plugin = require('./src/plugin');

module.exports = plugin.default ?? plugin;
