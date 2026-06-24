const { createApp } = require('../apps/api/server');
const app = createApp();

module.exports = (req, res) => {
  if (req.url === '/' || req.url === '') req.url = '/health';
  return app(req, res);
};
