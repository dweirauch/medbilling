// Express 4 doesn't catch errors thrown inside async route handlers — an uncaught
// one can hang the request or crash the server. This wrapper forwards them to
// the error handler in app.js instead.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
