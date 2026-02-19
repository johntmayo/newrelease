'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  movies: [],
  total: 0,
  page: 1,
  totalPages: 1,
  loading: false,
  filters: {
    q: '',
    platform: '',
    type: '',
    genre: '',
    availability: '',
    sort: 'date',
  },
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const grid         = $('movies-grid');
const spinner      = $('loading-spinner');
const emptyState   = $('empty-state');
const setupNotice  = $('setup-notice');
const summaryBar   = $('summary-bar');
const resultCount  = $('result-count');
const clearFilters = $('clear-filters');
const pagination   = $('pagination');
const prevBtn      = $('prev-page');
const nextBtn      = $('next-page');
const pageInfo     = $('page-info');
const statusBadge  = $('status-badge');
const statusDot    = statusBadge.querySelector('.status-dot');
const statusText   = statusBadge.querySelector('.status-text');
const refreshBtn   = $('refresh-btn');
const themeToggle  = $('theme-toggle');
const searchInput  = $('search-input');
const platformFilter = $('platform-filter');
const typeFilter   = $('type-filter');
const genreFilter  = $('genre-filter');
const sortSelect   = $('sort-select');
const availFilter  = $('avail-filter');
const modalOverlay = $('modal-overlay');
const modalClose   = $('modal-close');

// ─── Theme ────────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('nr-theme');
  const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  setTheme(saved || prefer);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nr-theme', theme);
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'light' ? 'dark' : 'light');
});

// ─── API helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Status badge ─────────────────────────────────────────────────────────────
async function pollStatus() {
  try {
    const s = await apiFetch('/api/status');
    statusDot.className = `status-dot ${s.status}`;
    if (s.status === 'fetching') {
      statusText.textContent = 'Updating…';
    } else if (s.lastUpdated) {
      const d = new Date(s.lastUpdated);
      statusText.textContent = `Updated ${relativeTime(d)}`;
    } else {
      statusText.textContent = 'No data yet';
    }
    if (!s.hasTmdbKey) setupNotice.classList.remove('hidden');
  } catch { /* ignore */ }
}

function relativeTime(date) {
  const diff = (Date.now() - date) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

// ─── Filter population ────────────────────────────────────────────────────────
async function loadFilterOptions() {
  const [platforms, genres] = await Promise.allSettled([
    apiFetch('/api/platforms'),
    apiFetch('/api/genres'),
  ]);

  if (platforms.status === 'fulfilled') {
    platforms.value.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name} (${p.count})`;
      platformFilter.appendChild(opt);
    });
  }

  if (genres.status === 'fulfilled') {
    genres.value.slice(0, 20).forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = `${g.name} (${g.count})`;
      genreFilter.appendChild(opt);
    });
  }
}

// ─── Fetch & render movies ────────────────────────────────────────────────────
async function loadMovies() {
  if (state.loading) return;
  state.loading = true;

  grid.innerHTML = '';
  spinner.classList.remove('hidden');
  emptyState.classList.add('hidden');
  setupNotice.classList.add('hidden');
  pagination.classList.add('hidden');
  summaryBar.classList.add('hidden');

  const params = new URLSearchParams({
    page: state.page,
    limit: 40,
    sort: state.filters.sort,
  });
  if (state.filters.q)            params.set('q', state.filters.q);
  if (state.filters.platform)     params.set('platform', state.filters.platform);
  if (state.filters.type)         params.set('type', state.filters.type);
  if (state.filters.genre)        params.set('genre', state.filters.genre);
  if (state.filters.availability) params.set('availability', state.filters.availability);

  try {
    const data = await apiFetch(`/api/movies?${params}`);

    state.movies = data.movies;
    state.total = data.total;
    state.totalPages = data.totalPages;

    spinner.classList.add('hidden');

    // Check if API key is missing (demo data)
    if (data.movies.some(m => m.source === 'demo')) {
      setupNotice.classList.remove('hidden');
      return;
    }

    if (data.movies.length === 0) {
      emptyState.classList.remove('hidden');
    } else {
      renderMovies(data.movies);
    }

    // Summary bar
    summaryBar.classList.remove('hidden');
    const hasFilters = state.filters.q || state.filters.platform || state.filters.type || state.filters.genre || state.filters.availability;
    resultCount.textContent = `${data.total.toLocaleString()} movie${data.total !== 1 ? 's' : ''}`;
    clearFilters.classList.toggle('hidden', !hasFilters);

    // Pagination
    if (data.totalPages > 1) {
      pagination.classList.remove('hidden');
      prevBtn.disabled = state.page <= 1;
      nextBtn.disabled = state.page >= data.totalPages;
      pageInfo.textContent = `Page ${state.page} of ${data.totalPages}`;
    }

    // Refresh filter options after first load
    if (state.page === 1 && !hasFilters) {
      loadFilterOptions().catch(() => {});
    }

  } catch (err) {
    spinner.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.querySelector('p').textContent = `Error loading movies: ${err.message}`;
  } finally {
    state.loading = false;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderMovies(movies) {
  const frag = document.createDocumentFragment();
  movies.forEach(m => frag.appendChild(createCard(m)));
  grid.appendChild(frag);
}

function createCard(movie) {
  const card = document.createElement('div');
  card.className = 'movie-card';
  card.setAttribute('data-id', movie.id);

  const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : '';
  const rtScore = movie.rtScore;
  const tmdbScore = movie.tmdbRating;

  card.innerHTML = `
    <div class="card-poster-wrap">
      ${movie.poster
        ? `<img class="card-poster" src="${escHtml(movie.poster)}" alt="${escHtml(movie.title)}" loading="lazy" />`
        : `<div class="card-poster-placeholder"><span class="ph-icon">🎬</span><span>${escHtml(movie.title)}</span></div>`
      }
      ${tmdbScore ? `<div class="card-rating"><span class="star">★</span>${tmdbScore}</div>` : ''}
      ${rtScore ? `<div class="card-rt-badge">🍅 ${rtScore}%</div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title">${escHtml(movie.title)}</div>
      ${year ? `<div class="card-date">${year}</div>` : ''}
      ${(movie.genres || []).length
        ? `<div class="card-genres">${movie.genres.slice(0, 3).map(g => `<span class="genre-tag">${escHtml(g)}</span>`).join('')}</div>`
        : ''
      }
    </div>
    <div class="card-providers">
      ${renderProviderChips(movie.providers || [], 3, movie.inTheaters)}
    </div>
  `;

  card.addEventListener('click', () => openModal(movie));
  return card;
}

function renderProviderChips(providers, maxShow = 99, inTheaters = false) {
  const shown = providers.slice(0, maxShow);
  const rest = providers.length - shown.length;

  let html = shown.map(p => {
    const typeClass = p.type?.split('+')[0] || 'stream';
    const logoHtml = p.logo ? `<img class="provider-logo" src="${escHtml(p.logo)}" alt="" />` : '';
    return `<span class="provider-chip ${typeClass}">${logoHtml}${escHtml(p.name)}</span>`;
  }).join('');

  if (rest > 0) html += `<span class="provider-chip stream">+${rest}</span>`;

  // Show "In Theaters" chip for movies without streaming providers
  const hasStream = providers.some(p => p.type?.includes('stream'));
  if (inTheaters && !hasStream) {
    html = `<span class="provider-chip theater">🎭 In Theaters</span>` + html;
  }

  return html;
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal(movie) {
  const backdrop = $('modal-backdrop');
  if (movie.backdrop) {
    backdrop.style.backgroundImage = `url(${movie.backdrop})`;
  } else {
    backdrop.style.backgroundImage = '';
    backdrop.style.background = 'var(--bg3)';
  }

  const posterEl = $('modal-poster');
  if (movie.poster) {
    posterEl.src = movie.poster;
    posterEl.alt = movie.title;
    posterEl.classList.remove('hidden');
  } else {
    posterEl.classList.add('hidden');
  }

  $('modal-title').textContent = movie.title || '';
  $('modal-tagline').textContent = movie.tagline || '';
  $('modal-overview').textContent = movie.overview || '';

  const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : '';
  $('modal-year').textContent = year;

  const runtime = movie.runtime ? `${movie.runtime} min` : '';
  $('modal-runtime').textContent = runtime ? `· ${runtime}` : '';

  const mpaaEl = $('modal-mpaa');
  if (movie.mpaaRating) {
    mpaaEl.textContent = movie.mpaaRating;
    mpaaEl.classList.remove('hidden');
  } else {
    mpaaEl.classList.add('hidden');
  }

  // Scores
  const tmdbScoreEl = $('modal-tmdb-score');
  if (movie.tmdbRating) {
    $('modal-tmdb-val').textContent = `${movie.tmdbRating}/10`;
    tmdbScoreEl.classList.remove('hidden');
  } else {
    tmdbScoreEl.classList.add('hidden');
  }

  const rtScoreEl = $('modal-rt-score');
  if (movie.rtScore) {
    $('modal-rt-val').textContent = `${movie.rtScore}%`;
    rtScoreEl.classList.remove('hidden');
  } else {
    rtScoreEl.classList.add('hidden');
  }

  const audScoreEl = $('modal-audience-score');
  if (movie.audienceScore) {
    $('modal-audience-val').textContent = `${movie.audienceScore}%`;
    audScoreEl.classList.remove('hidden');
  } else {
    audScoreEl.classList.add('hidden');
  }

  // Genres
  $('modal-genres').innerHTML = (movie.genres || [])
    .map(g => `<span class="genre-tag">${escHtml(g)}</span>`).join('');

  // Providers
  const hasModalStream = (movie.providers || []).some(p => p.type?.includes('stream'));
  const theaterChipHtml = movie.inTheaters && !hasModalStream
    ? `<div class="modal-provider-chip theater-chip">🎭 <span>In Theaters</span><span class="type-badge theater-badge">Now Playing</span></div>`
    : '';
  $('modal-providers').innerHTML = theaterChipHtml + (movie.providers || []).map(p => {
    const types = (p.type || 'stream').split('+');
    const badgesHtml = types.map(t => `<span class="type-badge ${t}">${typeLabel(t)}</span>`).join('');
    const logoHtml = p.logo
      ? `<img class="modal-provider-logo" src="${escHtml(p.logo)}" alt="" />`
      : '';
    return `<div class="modal-provider-chip">${logoHtml}${escHtml(p.name)}${badgesHtml}</div>`;
  }).join('');

  // Links
  const linksEl = $('modal-links');
  const links = [];
  const rtLink = movie.rtUrl || buildRtUrl(movie.title);
  if (rtLink) links.push(`<a class="modal-link-btn" href="${escHtml(rtLink)}" target="_blank" rel="noopener">🍅 Rotten Tomatoes</a>`);
  if (movie.imdbId) links.push(`<a class="modal-link-btn" href="https://www.imdb.com/title/${escHtml(movie.imdbId)}/" target="_blank" rel="noopener">IMDb</a>`);
  if (movie.id && movie.source !== 'demo') {
    links.push(`<a class="modal-link-btn" href="https://www.themoviedb.org/movie/${movie.id}" target="_blank" rel="noopener">TMDB</a>`);
  }
  linksEl.innerHTML = links.join('');

  modalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

function typeLabel(t) {
  return { stream: 'Streaming', rent: 'Rent', buy: 'Buy' }[t] || t;
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ─── Filter wiring ────────────────────────────────────────────────────────────
let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.filters.q = searchInput.value.trim();
    state.page = 1;
    loadMovies();
  }, 350);
});

platformFilter.addEventListener('change', () => {
  state.filters.platform = platformFilter.value;
  state.page = 1;
  loadMovies();
});

typeFilter.addEventListener('change', () => {
  state.filters.type = typeFilter.value;
  state.page = 1;
  loadMovies();
});

genreFilter.addEventListener('change', () => {
  state.filters.genre = genreFilter.value;
  state.page = 1;
  loadMovies();
});

sortSelect.addEventListener('change', () => {
  state.filters.sort = sortSelect.value;
  state.page = 1;
  loadMovies();
});

availFilter.addEventListener('click', e => {
  const btn = e.target.closest('.avail-btn');
  if (!btn) return;
  availFilter.querySelectorAll('.avail-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.filters.availability = btn.dataset.value;
  state.page = 1;
  loadMovies();
});

clearFilters.addEventListener('click', () => {
  state.filters = { q: '', platform: '', type: '', genre: '', availability: '', sort: 'date' };
  state.page = 1;
  searchInput.value = '';
  platformFilter.value = '';
  typeFilter.value = '';
  genreFilter.value = '';
  sortSelect.value = 'date';
  availFilter.querySelectorAll('.avail-btn').forEach(b => b.classList.toggle('active', b.dataset.value === ''));
  loadMovies();
});

// ─── Pagination ───────────────────────────────────────────────────────────────
prevBtn.addEventListener('click', () => {
  if (state.page > 1) { state.page--; loadMovies(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
nextBtn.addEventListener('click', () => {
  if (state.page < state.totalPages) { state.page++; loadMovies(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});

// ─── Refresh button ───────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', async () => {
  refreshBtn.textContent = '↻ Refreshing…';
  refreshBtn.disabled = true;
  try {
    await fetch('/api/refresh', { method: 'POST' });
    // Poll until done
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const s = await apiFetch('/api/status').catch(() => null);
      if (!s || s.status !== 'fetching' || attempts > 40) {
        clearInterval(poll);
        refreshBtn.textContent = '↻ Refresh';
        refreshBtn.disabled = false;
        await loadMovies();
        await loadFilterOptions();
        await pollStatus();
      }
    }, 3000);
  } catch {
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.disabled = false;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildRtUrl(title) {
  if (!title) return null;
  const slug = title
    .toLowerCase()
    .replace(/[''´`]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `https://www.rottentomatoes.com/m/${slug}`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  initTheme();
  await loadMovies();
  await pollStatus();

  // Refresh status every 30 seconds
  setInterval(pollStatus, 30_000);

  // Auto-reload movies when a background refresh finishes
  let lastUpdated = null;
  setInterval(async () => {
    try {
      const s = await apiFetch('/api/status');
      if (s.lastUpdated && s.lastUpdated !== lastUpdated && s.status === 'ready') {
        lastUpdated = s.lastUpdated;
        if (state.page === 1) {
          loadMovies();
          loadFilterOptions();
        }
      }
    } catch { /* ignore */ }
  }, 60_000);
}

init();
