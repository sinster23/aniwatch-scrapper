const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');

const filter = express();
const cors = require('cors');
filter.use(cors());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function getHeaders() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://aniwatchtv.to/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Cache-Control': 'no-cache',
  };
}

async function fetchWithRetry(url, retries = 3, backoffMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        headers: getHeaders(),
        timeout: 15000,
        httpAgent:  new http.Agent({ keepAlive: false }),
        httpsAgent: new https.Agent({ keepAlive: false }),
      });
    } catch (err) {
      const isRetryable =
        err.code === 'ECONNRESET'   ||
        err.code === 'ECONNABORTED' ||
        err.code === 'ETIMEDOUT'    ||
        (err.response?.status >= 500);
      if (attempt < retries && isRetryable) {
        const wait = backoffMs * attempt;
        console.log(`[filter] Attempt ${attempt} failed — retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      } else throw err;
    }
  }
}

// ── Maps derived from actual page HTML ───────────────────────────────────────
// From <select name="type">: Movie=1, TV=2, OVA=3, ONA=4, Special=5, Music=6
const TYPE_MAP = {
  movie:   1,
  tv:      2,
  ova:     3,
  ona:     4,
  special: 5,
  music:   6,
};

// From <select name="status">: Finished=1, Currently=2, Not yet=3
const STATUS_MAP = {
  finished_airing:  1,
  currently_airing: 2,
  not_yet_aired:    3,
};

// From <select name="season">: Spring=1, Summer=2, Fall=3, Winter=4
const SEASON_MAP = {
  spring: 1,
  summer: 2,
  fall:   3,
  winter: 4,
};

// From <select name="language">: SUB=1, DUB=2, SUB&DUB=3
const LANG_MAP = {
  sub:     1,
  dub:     2,
  sub_dub: 3,
};

const SORT_MAP = {
  recently_added:   'recently_added',
  recently_updated: 'recently_updated',
  score:            'score',
  released_date:    'released_date',
  most_watched:     'most_watched',
  default:          'default',
};

// From .f-genre-item data-id attributes in the HTML
const GENRE_MAP = {
  action:          1,
  adventure:       2,
  cars:            3,
  comedy:          4,
  dementia:        5,
  demons:          6,
  mystery:         7,
  drama:           8,
  ecchi:           9,
  fantasy:         10,
  game:            11,
  historical:      13,
  horror:          14,
  kids:            15,
  magic:           16,
  'martial-arts':  17,
  mecha:           18,
  music:           19,
  parody:          20,
  samurai:         21,
  romance:         22,
  school:          23,
  'sci-fi':        24,
  shoujo:          25,
  'shoujo-ai':     26,
  shounen:         27,
  'shounen-ai':    28,
  space:           29,
  sports:          30,
  'super-power':   31,
  vampire:         32,
  yaoi:            33,
  yuri:            34,
  harem:           35,
  'slice-of-life': 36,
  supernatural:    37,
  military:        38,
  police:          39,
  psychological:   40,
  thriller:        41,
  seinen:          42,
  josei:           43,
  isekai:          44,
};

// ── /api/filter ───────────────────────────────────────────────────────────────
filter.get('/filter', async (req, res) => {
  try {
    const {
      keyword  = '',
      type     = '',
      status   = '',
      season   = '',
      language = '',
      genres   = '',
      sort     = 'default',
      page     = 1,
    } = req.query;

    const buildParams = (pageNum) => {
      const p = new URLSearchParams();

      if (keyword) p.set('keyword', keyword);
      if (sort)    p.set('sort', SORT_MAP[sort] || 'default');
      p.set('page', String(pageNum));

      // Single-value selects
      if (type     && TYPE_MAP[type.toLowerCase()])     p.set('type',     TYPE_MAP[type.toLowerCase()]);
      if (status   && STATUS_MAP[status.toLowerCase()]) p.set('status',   STATUS_MAP[status.toLowerCase()]);
      if (season   && SEASON_MAP[season.toLowerCase()]) p.set('season',   SEASON_MAP[season.toLowerCase()]);
      if (language && LANG_MAP[language.toLowerCase()]) p.set('language', LANG_MAP[language.toLowerCase()]);

      // Genres — comma-separated numeric IDs in a SINGLE param
      // e.g. genres=1,10,22  (not genres=1&genres=10)
      if (genres) {
        const ids = genres
          .split(',')
          .map(g => g.trim().toLowerCase().replace(/\s+/g, '-'))
          .filter(Boolean)
          .map(g => GENRE_MAP[g])
          .filter(Boolean);

        if (ids.length > 0) {
          p.set('genres', ids.join(','));
        }
      }

      return p;
    };

    const currentParams = buildParams(page);
    const nextParams    = buildParams(parseInt(page) + 1);

    const filterUrl     = `https://aniwatchtv.to/filter?${currentParams.toString()}`;
    const filterUrlNext = `https://aniwatchtv.to/filter?${nextParams.toString()}`;

    console.log('[filter] Fetching:', filterUrl);

    const [currentRes, nextRes] = await Promise.allSettled([
      fetchWithRetry(filterUrl),
      fetchWithRetry(filterUrlNext),
    ]);

    if (currentRes.status === 'rejected') {
      console.error('[filter] Fetch failed:',
        currentRes.reason?.code,
        currentRes.reason?.response?.status,
        currentRes.reason?.message
      );
      return res.status(502).json({
        error:   'Failed to fetch from source',
        code:    currentRes.reason?.code,
        status:  currentRes.reason?.response?.status,
        message: currentRes.reason?.message,
      });
    }

    const html = currentRes.value.data;

    // Cloudflare check
    if (typeof html === 'string' && (
      html.includes('Just a moment')           ||
      html.includes('Checking your browser')   ||
      html.includes('cf-browser-verification') ||
      html.includes('Enable JavaScript and cookies')
    )) {
      console.error('[filter] Cloudflare challenge detected');
      return res.status(503).json({ error: 'Blocked by Cloudflare' });
    }

    const $ = cheerio.load(html);

    // Total results count from the page
    const totalText = $('.bah-result span').text().trim();
    const totalResults = parseInt(totalText.replace(/[^0-9]/g, '')) || 0;

    // Last page number from pagination
    const lastPageHref = $('.pagination .page-item:last-child a').attr('href') || '';
    const lastPageMatch = lastPageHref.match(/page=(\d+)/);
    const totalPages = lastPageMatch ? parseInt(lastPageMatch[1]) : null;

    // hasNextPage
    let hasNextPage = false;
    if (nextRes.status === 'fulfilled') {
      const $next = cheerio.load(nextRes.value.data);
      hasNextPage  = $next('.flw-item').length > 0;
    }

    // Parse anime cards
    const results = [];
    $('.flw-item').each((_, el) => {
      const name     = $(el).find('.dynamic-name').text().trim();
      const jname    = $(el).find('.dynamic-name').attr('data-jname')           || '';
      const format   = $(el).find('.fdi-item:first').text().trim();
      const duration = $(el).find('.fdi-item.fdi-duration').text().trim();
      const idanime  = $(el).find('.film-poster-ahref').attr('href')
                         ?.split('/')[1]?.split('?')[0]                         || '';
      const sub      = $(el).find('.tick-item.tick-sub').text().trim()          || false;
      const dubani   = $(el).find('.tick-item.tick-dub').text().trim()          || false;
      const totalep  = $(el).find('.tick-item.tick-eps').text().trim()          || false;
      const img      = $(el).find('.film-poster-img').attr('data-src')          || '';
      const pg       = $(el).find('.tick.tick-rate').text().trim()              || false;

      if (name && idanime) {
        results.push({ name, jname, format, duration, idanime, sub, dubani, totalep, img, pg });
      }
    });

    console.log(`[filter] Page ${page} → ${results.length} results, total: ${totalResults}, hasNextPage: ${hasNextPage}`);

    if (results.length === 0) {
      console.log('[filter] Zero results — HTML snippet:\n', html.slice(0, 600));
    }

    res.json({
      currentPage:  parseInt(page),
      hasNextPage,
      totalPages,
      totalResults,
      results,
    });

  } catch (error) {
    console.error('[filter] Unexpected error:', error.code, error.message);
    res.status(500).json({
      error:   'Internal Server Error',
      code:    error.code,
      details: error.message,
    });
  }
});

module.exports = filter;