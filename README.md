# NewRelease 🎬

A self-hosted website that automatically aggregates movies newly released to streaming platforms, including titles available for streaming, rent, or purchase.

## Features

- **Live data** – scrapes TMDB and supplements with Rotten Tomatoes scores
- **All access types** – streaming (included), rent, and buy
- **Filter & search** – by platform, genre, access type, or title keyword
- **Sort** – by release date, TMDB rating, popularity, or title
- **Auto-refresh** – data refreshes every 6 hours automatically (configurable)
- **Dark / light mode**
- **Responsive** – works on mobile and desktop

## Quick start

### 1. Get a free TMDB API key

Register at [themoviedb.org](https://www.themoviedb.org/signup) and copy your API key from [Settings → API](https://www.themoviedb.org/settings/api). It's completely free.

### 2. Configure

```bash
cp .env.example .env
# Edit .env and add your TMDB_API_KEY
```

### 3. Install and run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TMDB_API_KEY` | *(required)* | Free API key from themoviedb.org |
| `PORT` | `3000` | Web server port |
| `REFRESH_INTERVAL_HOURS` | `6` | How often to scrape fresh data |
| `REGION` | `US` | Country code for streaming availability |

## Data sources

- **[TMDB](https://www.themoviedb.org)** – movie metadata, posters, ratings, streaming providers
- **[Rotten Tomatoes](https://www.rottentomatoes.com/browse/movies_at_home/)** – critic and audience scores (scraped)

## Deploy to Vercel

1. Push the repo to GitHub
2. Import the project at [vercel.com/new](https://vercel.com/new)
3. Add the environment variable `TMDB_API_KEY` in **Settings → Environment Variables**
4. Deploy — Vercel auto-detects Node.js and uses `vercel.json` for routing

> **Note:** Vercel is serverless, so `node-cron` won't run between cold starts. Data is cached in `/tmp` while the container is warm. Use the **↻ Refresh** button in the UI to force a fresh scrape any time.

## Development

```bash
npm run dev   # auto-restarts on file changes (Node 22+)
```

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/movies` | Filtered/sorted movie list |
| `GET /api/status` | Cache health and last update time |
| `GET /api/platforms` | Distinct streaming platforms |
| `GET /api/genres` | Distinct genres |
| `POST /api/refresh` | Trigger immediate data refresh |

Query params for `/api/movies`: `q`, `platform`, `type` (`stream`/`rent`/`buy`), `genre`, `sort` (`date`/`rating`/`popularity`/`title`), `page`, `limit`.
