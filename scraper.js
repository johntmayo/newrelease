'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_KEY = process.env.TMDB_API_KEY;

// Provider name → logo slug mapping for well-known services
const PROVIDER_LOGOS = {
  'Netflix': 'netflix',
  'Amazon Prime Video': 'prime',
  'Disney+': 'disney-plus',
  'Hulu': 'hulu',
  'HBO Max': 'max',
  'Max': 'max',
  'Apple TV+': 'apple-tv-plus',
  'Peacock': 'peacock',
  'Paramount+': 'paramount-plus',
  'Tubi': 'tubi',
  'Pluto TV': 'pluto-tv',
  'Vudu': 'vudu',
  'Crunchyroll': 'crunchyroll',
  'Mubi': 'mubi',
  'Shudder': 'shudder',
};

function tmdbImageUrl(path) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}${path}`;
}

// Map TMDB provider objects to a standardised shape
function normalizeProviders(providerData, region) {
  const regionData = providerData?.results?.[region] || {};
  const providers = {};

  (regionData.flatrate || []).forEach(p => {
    providers[p.provider_id] = {
      id: p.provider_id,
      name: p.provider_name,
      logo: tmdbImageUrl(p.logo_path),
      type: 'stream',
    };
  });
  (regionData.rent || []).forEach(p => {
    if (!providers[p.provider_id]) {
      providers[p.provider_id] = {
        id: p.provider_id,
        name: p.provider_name,
        logo: tmdbImageUrl(p.logo_path),
        type: 'rent',
      };
    } else {
      providers[p.provider_id].type = 'stream+rent';
    }
  });
  (regionData.buy || []).forEach(p => {
    if (!providers[p.provider_id]) {
      providers[p.provider_id] = {
        id: p.provider_id,
        name: p.provider_name,
        logo: tmdbImageUrl(p.logo_path),
        type: 'buy',
      };
    } else if (providers[p.provider_id].type === 'rent') {
      providers[p.provider_id].type = 'rent+buy';
    } else if (!providers[p.provider_id].type.includes('buy')) {
      providers[p.provider_id].type += '+buy';
    }
  });

  return Object.values(providers);
}

// Fetch a single page of TMDB discover results for home-release movies
async function fetchTmdbPage(page, region, daysBack = 90) {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');

  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  const params = {
    api_key: TMDB_KEY,
    sort_by: 'primary_release_date.desc',
    // release types 4 = Digital, 5 = Physical – both indicate home availability
    with_release_type: '4|5',
    'primary_release_date.gte': sinceStr,
    'primary_release_date.lte': todayStr,
    region,
    page,
    'vote_count.gte': 5,
  };

  const { data } = await axios.get(`${TMDB_BASE}/discover/movie`, { params, timeout: 10000 });
  return data;
}

// Fetch watch-provider data for a movie id
async function fetchProviders(movieId, region) {
  if (!TMDB_KEY) return [];
  try {
    const { data } = await axios.get(`${TMDB_BASE}/movie/${movieId}/watch/providers`, {
      params: { api_key: TMDB_KEY },
      timeout: 8000,
    });
    return normalizeProviders(data, region);
  } catch {
    return [];
  }
}

// Fetch full details (genres, runtime, tagline) for a movie
async function fetchDetails(movieId) {
  if (!TMDB_KEY) return {};
  try {
    const { data } = await axios.get(`${TMDB_BASE}/movie/${movieId}`, {
      params: { api_key: TMDB_KEY },
      timeout: 8000,
    });
    return {
      tagline: data.tagline || '',
      runtime: data.runtime || null,
      genres: (data.genres || []).map(g => g.name),
      imdbId: data.imdb_id || null,
      homepage: data.homepage || null,
      budget: data.budget || null,
      revenue: data.revenue || null,
    };
  } catch {
    return {};
  }
}

// Scrape Rotten Tomatoes "Movies At Home" page for supplementary data
async function scrapeRottenTomatoes() {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
    };

    const { data: html } = await axios.get('https://www.rottentomatoes.com/browse/movies_at_home/', {
      headers,
      timeout: 15000,
    });

    const $ = cheerio.load(html);
    const movies = [];

    // RT embeds page state in a JSON script tag
    $('script[type="application/json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());
        if (json?.page?.items) {
          json.page.items.forEach(item => {
            if (item.type === 'movie') {
              movies.push({
                title: item.title,
                year: item.year,
                rtScore: item.tomatometer,
                audienceScore: item.audienceScore,
                rtUrl: item.url ? `https://www.rottentomatoes.com${item.url}` : null,
                rtPoster: item.posterUri,
                mpaaRating: item.mpaaRating,
              });
            }
          });
        }
      } catch {
        // not a JSON block we need
      }
    });

    // Fallback: parse tile elements from the DOM
    if (movies.length === 0) {
      $('[data-track="scores"]').each((_, el) => {
        const titleEl = $(el).find('[data-qa="discovery-media-list-item-title"]');
        const scoreEl = $(el).find('[data-qa="tomatometer"]');
        const linkEl = $(el).closest('a');
        movies.push({
          title: titleEl.text().trim(),
          rtScore: scoreEl.text().trim(),
          rtUrl: linkEl.attr('href') ? `https://www.rottentomatoes.com${linkEl.attr('href')}` : null,
        });
      });
    }

    console.log(`[RT] Scraped ${movies.length} movies from Rotten Tomatoes`);
    return movies;
  } catch (err) {
    console.warn('[RT] Scrape failed:', err.message);
    return [];
  }
}

// Scrape JustWatch new releases page for extra provider coverage
async function scrapeJustWatch(region = 'en_US') {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    // JustWatch has a public content API used by their web app
    const body = {
      page_size: 40,
      page: 1,
      content_types: ['movie'],
      monetization_types: ['flatrate', 'rent', 'buy'],
      sort_by: 'original_release_date',
      sort_ascending: false,
    };

    const { data } = await axios.post(
      `https://apis.justwatch.com/content/titles/${region}/popular`,
      body,
      { headers, timeout: 12000 }
    );

    const movies = (data?.items || []).map(item => {
      const offers = item.offers || [];
      const providers = [...new Set(offers.map(o => o.provider_id))];
      return {
        title: item.title,
        year: item.original_release_year,
        poster: item.poster ? `https://images.justwatch.com${item.poster.replace('{profile}', 's592')}` : null,
        jwScore: item.scoring?.find(s => s.provider_type === 'tomato:meter')?.value,
        providerIds: providers,
      };
    });

    console.log(`[JW] Scraped ${movies.length} movies from JustWatch`);
    return movies;
  } catch (err) {
    console.warn('[JW] Scrape failed:', err.message);
    return [];
  }
}

// Build a lookup map: normalised title → RT data
function buildRtLookup(rtMovies) {
  const map = {};
  rtMovies.forEach(m => {
    if (m.title) map[m.title.toLowerCase()] = m;
  });
  return map;
}

// Main export: fetch and merge movies from all sources
async function fetchMovies(region = 'US', maxPages = 5) {
  const movies = [];
  const seen = new Set();

  if (!TMDB_KEY) {
    console.warn('[Scraper] No TMDB_API_KEY – returning demo data');
    return getDemoMovies();
  }

  // 1. Scrape supplementary sources in parallel with TMDB page 1
  const [rtMovies, page1Data] = await Promise.allSettled([
    scrapeRottenTomatoes(),
    fetchTmdbPage(1, region),
  ]);

  const rtList = rtMovies.status === 'fulfilled' ? rtMovies.value : [];
  const rtLookup = buildRtLookup(rtList);

  if (page1Data.status !== 'fulfilled') {
    console.error('[TMDB] Failed to fetch page 1:', page1Data.reason?.message);
    // Fall back to RT-only or demo data
    return rtList.length ? rtList.map(rt => ({ ...rt, providers: [], source: 'rt' })) : getDemoMovies();
  }

  const totalPages = Math.min(page1Data.value.total_pages || 1, maxPages);
  const allPages = [page1Data.value];

  // Fetch remaining pages
  if (totalPages > 1) {
    const remaining = [];
    for (let p = 2; p <= totalPages; p++) remaining.push(fetchTmdbPage(p, region));
    const results = await Promise.allSettled(remaining);
    results.forEach(r => { if (r.status === 'fulfilled') allPages.push(r.value); });
  }

  // Collect all movie stubs
  const stubs = [];
  allPages.forEach(page => {
    (page.results || []).forEach(m => {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        stubs.push(m);
      }
    });
  });

  console.log(`[TMDB] ${stubs.length} movies found across ${allPages.length} pages`);

  // Fetch details and providers for each movie (batched to avoid rate-limits)
  const BATCH = 10;
  for (let i = 0; i < stubs.length; i += BATCH) {
    const batch = stubs.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async m => {
        const [providers, details] = await Promise.all([
          fetchProviders(m.id, region),
          fetchDetails(m.id),
        ]);

        const rtData = rtLookup[m.title?.toLowerCase()] || {};

        return {
          id: m.id,
          title: m.title,
          originalTitle: m.original_title !== m.title ? m.original_title : undefined,
          overview: m.overview,
          releaseDate: m.release_date,
          poster: tmdbImageUrl(m.poster_path),
          backdrop: tmdbImageUrl(m.backdrop_path),
          tmdbRating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
          voteCount: m.vote_count,
          popularity: m.popularity,
          adult: m.adult,
          // merged RT data
          rtScore: rtData.rtScore ?? null,
          audienceScore: rtData.audienceScore ?? null,
          rtUrl: rtData.rtUrl ?? null,
          mpaaRating: rtData.mpaaRating ?? null,
          // details
          ...details,
          // providers
          providers,
          source: 'tmdb',
          fetchedAt: new Date().toISOString(),
        };
      })
    );

    results.forEach(r => { if (r.status === 'fulfilled' && r.value) movies.push(r.value); });

    // Polite delay between batches
    if (i + BATCH < stubs.length) await new Promise(res => setTimeout(res, 300));
  }

  // Sort by release date descending
  movies.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));

  console.log(`[Scraper] Done – ${movies.length} movies ready`);
  return movies;
}

// Demo data shown when no API key is configured
function getDemoMovies() {
  return [
    {
      id: 1,
      title: 'Configure Your API Key',
      overview: 'Add your free TMDB API key to the .env file to start seeing real movies. Visit themoviedb.org/settings/api to get one.',
      releaseDate: new Date().toISOString().split('T')[0],
      poster: null,
      tmdbRating: null,
      providers: [{ id: 0, name: 'Setup Required', logo: null, type: 'stream' }],
      genres: ['Setup'],
      source: 'demo',
      fetchedAt: new Date().toISOString(),
    },
  ];
}

module.exports = { fetchMovies };
