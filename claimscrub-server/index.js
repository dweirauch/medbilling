require('dotenv').config(); // must run before anything reads process.env
const app = require('./app');
const { initSchema } = require('./db');

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`ClaimScrub server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
