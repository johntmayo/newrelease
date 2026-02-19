'use strict';

require('dotenv').config();

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { fetchMovies } = require('./scraper');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const REGION = process.env.REGION || 'US';
const REFRESH_HOURS = parseFloat(process.env.REFRESH_INTERVAL_HOURS || '6');

// Use /tmp on Vercel (read-only fs everywhere else); fall back to local data/
const DATA_FILE = process.env.VERCEL
  ? '/tmp/movies.json'
  : path.join(__dirname, 'data', 'movies.json');

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Data cache ───────────────────────────────────────────────────────────────
let cache = {
  movies: [],
  lastUpdated: null,
  status: 'idle',
  error: null,
};

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveCache() {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify({ movies: cache.movies, lastUpdated: cache.lastUpdated }, null, 2));
  } catch (err) {
    console.error('[Cache] Failed to save:', err.message);
  }
}

function loadCache() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      cache.movies = raw.movies || [];
      cache.lastUpdated = raw.lastUpdated || null;
      cache.status = cache.movies.length ? 'ready' : 'idle';
      console.log(`[Cache] Loaded ${cache.movies.length} movies (last updated: ${cache.lastUpdated})`);
    }
  } catch (err) {
    console.warn('[Cache] Could not load from disk:', err.message);
  }
}

async function refresh() {
  if (cache.status === 'fetching') return;
  cache.status = 'fetching';
  cache.error = null;
  console.log(`[Cache] Refreshing for region ${REGION}…`);
  try {
    const movies = await fetchMovies(REGION);
    cache.movies = movies;
    cache.lastUpdated = new Date().toISOString();
    cache.status = 'ready';
    saveCache();
    console.log(`[Cache] Done – ${movies.length} movies`);
  } catch (err) {
    cache.status = cache.movies.length ? 'ready' : 'error';
    cache.error = err.message;
    console.error('[Cache] Refresh failed:', err.message);
  }
}

// ─── Lazy initialisation (required for Vercel serverless) ────────────────────
// On Vercel there is no persistent process, so we initialise on the first
// incoming request rather than at module load time.
let initPromise = null;

async function ensureInitialized() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    loadCache();
    const stale =
      !cache.lastUpdated ||
      Date.now() - new Date(cache.lastUpdated).getTime() > REFRESH_HOURS * 3600 * 1000;

    if (stale) {
      if (cache.movies.length === 0) {
        // First ever run – wait so the first response has real data
        await refresh();
      } else {
        // Have cached data – refresh quietly in the background
        refresh();
      }
    }
  })();
  return initPromise;
}

app.use(async (_req, _res, next) => {
  try { await ensureInitialized(); } catch { /* serve stale/empty data rather than erroring */ }
  next();
});

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/movies', (req, res) => {
  let { q, platform, type, genre, sort = 'date', page = '1', limit = '40' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

  let movies = [...cache.movies];

  if (q) {
    const lq = q.toLowerCase();
    movies = movies.filter(m =>
      m.title?.toLowerCase().includes(lq) ||
      m.overview?.toLowerCase().includes(lq) ||
      m.genres?.some(g => g.toLowerCase().includes(lq))
    );
  }
  if (platform) {
    const lp = platform.toLowerCase();
    movies = movies.filter(m => m.providers?.some(p => p.name?.toLowerCase().includes(lp)));
  }
  if (type) {
    movies = movies.filter(m => m.providers?.some(p => p.type?.includes(type)));
  }
  if (genre) {
    const lg = genre.toLowerCase();
    movies = movies.filter(m => m.genres?.some(g => g.toLowerCase().includes(lg)));
  }

  switch (sort) {
    case 'rating':     movies.sort((a, b) => (b.tmdbRating || 0) - (a.tmdbRating || 0)); break;
    case 'popularity': movies.sort((a, b) => (b.popularity || 0) - (a.popularity || 0)); break;
    case 'title':      movies.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
    default:           movies.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  }

  const total = movies.length;
  const results = movies.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  res.json({
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum),
    lastUpdated: cache.lastUpdated,
    status: cache.status,
    movies: results,
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    status: cache.status,
    lastUpdated: cache.lastUpdated,
    movieCount: cache.movies.length,
    error: cache.error,
    region: REGION,
    hasTmdbKey: !!process.env.TMDB_API_KEY,
  });
});

app.post('/api/refresh', (req, res) => {
  res.json({ ok: true, message: 'Refresh triggered' });
  refresh();
});

app.get('/api/platforms', (_req, res) => {
  const map = {};
  cache.movies.forEach(m => {
    (m.providers || []).forEach(p => {
      if (!map[p.name]) map[p.name] = { name: p.name, logo: p.logo, count: 0 };
      map[p.name].count++;
    });
  });
  res.json(Object.values(map).sort((a, b) => b.count - a.count));
});

app.get('/api/genres', (_req, res) => {
  const counts = {};
  cache.movies.forEach(m => { (m.genres || []).forEach(g => { counts[g] = (counts[g] || 0) + 1; }); });
  res.json(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
// When running directly (local dev) → listen on a port.
// When imported by Vercel's runtime → export the app.
if (require.main === module) {
  // Schedule periodic refreshes (only meaningful in a persistent process)
  const cronExpr = REFRESH_HOURS >= 24 ? '0 3 * * *' : `0 */${Math.round(REFRESH_HOURS)} * * *`;
  cron.schedule(cronExpr, () => { console.log('[Cron] Scheduled refresh'); refresh(); });

  loadCache();
  const stale =
    !cache.lastUpdated ||
    Date.now() - new Date(cache.lastUpdated).getTime() > REFRESH_HOURS * 3600 * 1000;
  if (stale) refresh();

  app.listen(PORT, () => {
    console.log(`\n🎬  NewRelease running at http://localhost:${PORT}`);
    console.log(`   Region: ${REGION}  |  Refresh every ${REFRESH_HOURS}h`);
    if (!process.env.TMDB_API_KEY) {
      console.log('\n⚠️   TMDB_API_KEY not set. Copy .env.example to .env and add your key.');
    }
  });
} else {
  // Vercel serverless entry point
  module.exports = app;
}
