/* Local default: empty = same-origin (npm start / Render serving public/).
   Netlify build overwrites this via scripts/write-netlify-config.js from GAME_SERVER_URL. */
window.GAME_SERVER_URL = window.GAME_SERVER_URL || '';
