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
const DATA_FILE = path.join(__dirname, 'data', 'movies.json');

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Data cache ───────────────────────────────────────────────────────────────
let cache = {
  movies: [],
  lastUpdated: null,
  status: 'idle', // idle | fetching | ready | error
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
      console.log(`[Cache] Loaded ${cache.movies.length} movies from disk (last updated: ${cache.lastUpdated})`);
    }
  } catch (err) {
    console.warn('[Cache] Could not load from disk:', err.message);
  }
}

async function refresh() {
  if (cache.status === 'fetching') {
    console.log('[Cache] Already fetching, skipping');
    return;
  }
  cache.status = 'fetching';
  cache.error = null;
  console.log(`[Cache] Starting refresh for region ${REGION}…`);

  try {
    const movies = await fetchMovies(REGION);
    cache.movies = movies;
    cache.lastUpdated = new Date().toISOString();
    cache.status = 'ready';
    saveCache();
    console.log(`[Cache] Refresh done – ${movies.length} movies`);
  } catch (err) {
    cache.status = cache.movies.length ? 'ready' : 'error';
    cache.error = err.message;
    console.error('[Cache] Refresh failed:', err.message);
  }
}

// ─── API routes ───────────────────────────────────────────────────────────────

// GET /api/movies – return filtered/sorted movie list
app.get('/api/movies', (req, res) => {
  let { q, platform, type, genre, sort = 'date', page = '1', limit = '40' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

  let movies = [...cache.movies];

  // text search
  if (q) {
    const lq = q.toLowerCase();
    movies = movies.filter(m =>
      m.title?.toLowerCase().includes(lq) ||
      m.overview?.toLowerCase().includes(lq) ||
      m.genres?.some(g => g.toLowerCase().includes(lq))
    );
  }

  // filter by streaming platform name
  if (platform) {
    const lp = platform.toLowerCase();
    movies = movies.filter(m =>
      m.providers?.some(p => p.name?.toLowerCase().includes(lp))
    );
  }

  // filter by availability type: stream | rent | buy
  if (type) {
    movies = movies.filter(m =>
      m.providers?.some(p => p.type?.includes(type))
    );
  }

  // filter by genre
  if (genre) {
    const lg = genre.toLowerCase();
    movies = movies.filter(m =>
      m.genres?.some(g => g.toLowerCase().includes(lg))
    );
  }

  // sorting
  switch (sort) {
    case 'rating':
      movies.sort((a, b) => (b.tmdbRating || 0) - (a.tmdbRating || 0));
      break;
    case 'popularity':
      movies.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      break;
    case 'title':
      movies.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    case 'date':
    default:
      movies.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  }

  const total = movies.length;
  const offset = (pageNum - 1) * limitNum;
  const results = movies.slice(offset, offset + limitNum);

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

// GET /api/status – health / cache status
app.get('/api/status', (req, res) => {
  res.json({
    status: cache.status,
    lastUpdated: cache.lastUpdated,
    movieCount: cache.movies.length,
    error: cache.error,
    region: REGION,
    hasTmdbKey: !!process.env.TMDB_API_KEY,
  });
});

// POST /api/refresh – manually trigger a refresh
app.post('/api/refresh', async (req, res) => {
  res.json({ ok: true, message: 'Refresh triggered' });
  refresh(); // fire and forget
});

// GET /api/platforms – list of distinct platforms in current data
app.get('/api/platforms', (req, res) => {
  const map = {};
  cache.movies.forEach(m => {
    (m.providers || []).forEach(p => {
      if (!map[p.name]) map[p.name] = { name: p.name, logo: p.logo, count: 0 };
      map[p.name].count++;
    });
  });
  const platforms = Object.values(map).sort((a, b) => b.count - a.count);
  res.json(platforms);
});

// GET /api/genres – list of distinct genres
app.get('/api/genres', (req, res) => {
  const counts = {};
  cache.movies.forEach(m => {
    (m.genres || []).forEach(g => {
      counts[g] = (counts[g] || 0) + 1;
    });
  });
  const genres = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  res.json(genres);
});

// Catch-all → SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  loadCache();

  // Kick off a refresh if cache is stale (older than REFRESH_HOURS) or empty
  const stale =
    !cache.lastUpdated ||
    Date.now() - new Date(cache.lastUpdated).getTime() > REFRESH_HOURS * 3600 * 1000;

  if (stale) {
    console.log('[Startup] Cache is stale or empty – refreshing now…');
    refresh(); // non-blocking
  }

  // Schedule periodic refreshes using cron
  // Build cron expression for every N hours
  const cronExpr =
    REFRESH_HOURS >= 24
      ? '0 3 * * *' // daily at 3am
      : `0 */${Math.round(REFRESH_HOURS)} * * *`;

  cron.schedule(cronExpr, () => {
    console.log('[Cron] Scheduled refresh triggered');
    refresh();
  });

  app.listen(PORT, () => {
    console.log(`\n🎬  NewRelease is running at http://localhost:${PORT}`);
    console.log(`   Region: ${REGION}  |  Refresh every ${REFRESH_HOURS}h`);
    if (!process.env.TMDB_API_KEY) {
      console.log('\n⚠️   TMDB_API_KEY not set. Copy .env.example to .env and add your key.');
      console.log('   Get a free key at: https://www.themoviedb.org/settings/api\n');
    }
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
