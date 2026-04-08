const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const BRAND_NAME = 'Y-games';

// ── News RSS Fetcher ──────────────────────────────────────
const NEWS_SOURCES = [
  { sport: 'Cricket', tag: '🏏', url: 'https://feeds.bbci.co.uk/sport/cricket/rss.xml' },
  { sport: 'Cricket (TOI)', tag: '🏏', url: 'https://timesofindia.indiatimes.com/rssfeeds/4719148.cms' },
  { sport: 'Football', tag: '⚽', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { sport: 'Basketball', tag: '🏀', url: 'https://feeds.bbci.co.uk/sport/basketball/rss.xml' },
];

// Enhanced RSS fetch helper with retries
function fetchRSS(url, maxRetries = 2) {
  return new Promise((resolve) => {
    const attempt = (retryCount = 0) => {
      const client = url.startsWith('https') ? https : http;
      let data = '';
      let timeoutId;
      
      const req = client.get(url, { 
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Encoding': 'identity', // Don't accept compressed responses
          'Cache-Control': 'no-cache'
        },
        timeout: 10000 // 10 seconds total timeout
      }, (res) => {
        clearTimeout(timeoutId);
        
        if (res.statusCode !== 200) {
          console.warn(`[RSS] ${url} returned ${res.statusCode}`);
          if (retryCount < maxRetries) {
            setTimeout(() => attempt(retryCount + 1), 1000 * (retryCount + 1));
            return;
          }
          resolve(''); // Give up
          return;
        } else {
          console.log(`[RSS] ${url} connected (${res.statusCode}), headers:`, res.headers['content-type'], res.headers['content-length'] || 'unknown');
        }
        
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          console.log(`[RSS] ${url} received ${data.length} bytes, trimmed: ${data.trim().length}`);
          if (!data.trim() && retryCount < maxRetries) {
            console.warn(`[RSS] ${url} empty data, retrying (${retryCount + 1}/${maxRetries})`);
            setTimeout(() => attempt(retryCount + 1), 1000 * (retryCount + 1));
            return;
          }
          resolve(data);
        });
      });
      
      req.on('error', (err) => {
        clearTimeout(timeoutId);
        console.warn(`[RSS] ${url} attempt ${retryCount + 1}/${maxRetries + 1} failed: ${err.message}`);
        if (retryCount < maxRetries) {
          setTimeout(() => attempt(retryCount + 1), 1000 * (retryCount + 1));
          return;
        }
        resolve(''); // All retries failed
      });
      
      timeoutId = setTimeout(() => {
        req.destroy();
        console.warn(`[RSS] ${url} timeout on attempt ${retryCount + 1}`);
        if (retryCount < maxRetries) {
          setTimeout(() => attempt(retryCount + 1), 1000 * (retryCount + 1));
          return;
        }
        resolve('');
      }, 10000);
    };
    
    attempt();
  });
}

function parseRSSItems(xml, limit = 8) {
  const items = [];
  
  // Handle empty XML
  if (!xml || !xml.trim()) {
    console.warn('[Parse] Empty XML received');
    return items;
  }
  
  // More robust item matching with various RSS formats
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  let itemCount = 0;
  
  while ((match = itemRegex.exec(xml)) !== null && itemCount < limit) {
    itemCount++;
    const block = match[1];
    
    // Extract title (handles CDATA or plain)
    let titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    
    // Extract link (handles CDATA or plain, may have attributes)
    let linkMatch = block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
    const link = linkMatch ? linkMatch[1].trim() : '';
    
    // Extract description (handles CDATA or plain)
    let descMatch = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    const desc = descMatch ? descMatch[1].trim() : '';
    
    // Extract pubDate (may be dc:date or pubDate)
    let pubMatch = block.match(/<pubDate[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i) ||
                  block.match(/<dc:date[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:date>/i);
    const pub = pubMatch ? pubMatch[1].trim() : '';
    
    // Extract thumbnail - BBC uses media:thumbnail, TOI uses enclosure with .cms URLs
    let thumbMatch = block.match(/<media:thumbnail[^>]+url="([^"]+)"/i) ||
                    block.match(/<media:content[^>]+url="([^"]+)"/i) ||
                    block.match(/<enclosure[^>]+type="image\/[^"]*"[^>]+url="([^"]+)"/i) ||
                    block.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image\/[^"]*"/i) ||
                    block.match(/url="([^"]+\.(?:jpg|png|gif|webp|jpeg))"/i);
    const thumb = thumbMatch ? thumbMatch[1] : '';
    
    // Basic HTML entity decoding
    const decodeHTML = (text) => {
      if (!text) return text;
      return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'");
    };

    const stripHTML = (text) => {
      if (!text) return text;
      return text.replace(/<[^>]+>/g, '');
    };
    
    const decodedTitle = decodeHTML(title);
    const decodedLink = decodeHTML(link);
    const decodedDesc = stripHTML(decodeHTML(desc)).trim();
    
    if (decodedTitle && decodedLink) {
      items.push({
        title: decodedTitle,
        link: decodedLink,
        desc: decodedDesc,
        pub: decodeHTML(pub),
        thumb
      });
    } else {
      // Debug: log why item was skipped
      console.warn(`[Parse] Skipped item ${itemCount}: title="${decodedTitle}", link="${decodedLink}"`);
    }
  }
  
  if (items.length === 0 && itemCount > 0) {
    console.warn(`[Parse] Found ${itemCount} <item> blocks but parsed 0 items. XML sample: ${xml.substring(0, 500)}...`);
  }
  
  return items;
}

// ── News History Storage (keep 7 days) ──────────────────────
const newsHistory = {
  // Format: { [sport]: [{ timestamp: number, items: [...] }, ...] }
  cricket: [],
  'cricket (toi)': [],
  football: [],
  basketball: []
};

function addToHistory(sport, items) {
  if (!items.length) return;
  
  const now = Date.now();
  const historyEntry = { timestamp: now, items };
  
  if (!newsHistory[sport.toLowerCase()]) {
    newsHistory[sport.toLowerCase()] = [];
  }
  
  // Add to front (most recent first)
  newsHistory[sport.toLowerCase()].unshift(historyEntry);
  
  // Keep only last 7 days of history
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  newsHistory[sport.toLowerCase()] = newsHistory[sport.toLowerCase()].filter(
    entry => entry.timestamp >= sevenDaysAgo
  );
}

function getHistory(sport, limit = 20) {
  const sportKey = sport.toLowerCase();
  if (!newsHistory[sportKey]) return [];
  return newsHistory[sportKey].slice(0, limit);
}

// Cache news for 6 hours
let newsCache = { data: null, ts: 0 };

async function getNews() {
  const now = Date.now();
  if (newsCache.data && now - newsCache.ts < 6 * 60 * 60 * 1000) {
    // Return cached data, but log cache hit
    const ageMinutes = Math.round((now - newsCache.ts) / (1000 * 60));
    if (ageMinutes > 60) { // Only log if cache is older than 1 hour
      console.log(`[News] Using cache (${ageMinutes}m old)`);
    }
    return newsCache.data;
  }

  console.log(`[News] Fetching fresh news data at ${new Date().toISOString()}`);
  const startTime = Date.now();
  
  const results = await Promise.all(
    NEWS_SOURCES.map(async (src) => {
      try {
        console.log(`[News] Fetching ${src.sport} from ${src.url}`);
        const xml = await fetchRSS(src.url);
        const items = parseRSSItems(xml, 8);
        
        if (items.length > 0) {
          console.log(`[News] ✓ ${src.sport}: ${items.length} articles`);
          // Store in history
          addToHistory(src.sport, items);
          return { ...src, items };
        } else {
          console.warn(`[News] ✗ ${src.sport}: No articles parsed (empty or invalid RSS)`);
          return { ...src, items: [] };
        }
      } catch (error) {
        console.error(`[News] ✗ ${src.sport}: ${error.message}`);
        return { ...src, items: [] };
      }
    })
  );
  
  const totalArticles = results.reduce((sum, src) => sum + src.items.length, 0);
  const elapsed = Date.now() - startTime;
  console.log(`[News] Fetch completed in ${elapsed}ms: ${totalArticles} total articles`);
  
  newsCache = { data: results, ts: now };
  return results;
}

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

// ── Admin API: Manual News Refresh ───────────────────────
const lastForceUpdate = { ts: 0 };

app.get('/admin/news/refresh', async (req, res) => {
  const { key = '' } = req.query;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-local-2026';
  
  if (key !== ADMIN_KEY) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(401).json({
      success: false,
      message: 'Unauthorized. Provide ?key=... in query string.',
      hint: 'Current key (dev): dev-local-2026'
    });
  }
  
  try {
    // Clear cache to force fresh fetch
    newsCache = { data: null, ts: 0 };
    console.log(`[Admin] Manual news refresh requested at ${new Date().toISOString()}`);
    
    // Fetch fresh data
    const results = await getNews();
    const fetchedCount = results.reduce((sum, src) => sum + src.items.length, 0);
    
    res.setHeader('Content-Type', 'application/json');
    res.json({
      success: true,
      message: 'News cache refreshed successfully',
      timestamp: Date.now(),
      fetchedAt: new Date().toISOString(),
      stats: {
        totalSources: results.length,
        totalArticles: fetchedCount,
        bySport: results.map(src => ({
          sport: src.sport,
          articles: src.items.length,
          firstTitle: src.items[0]?.title || 'None'
        }))
      },
      cacheInfo: {
        cacheSize: `${JSON.stringify(newsCache).length} bytes`,
        cacheTime: new Date(newsCache.ts).toISOString()
      }
    });
  } catch (error) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({
      success: false,
      message: 'Refresh failed',
      error: error.message,
      timestamp: Date.now()
    });
  }
});

// ── Public API: Force News Update (rate-limited) ─────────
app.get('/api/news/force-update', async (req, res) => {
  const now = Date.now();
  const MIN_COOLDOWN = 30 * 1000; // 30 seconds cooldown
  
  if (now - lastForceUpdate.ts < MIN_COOLDOWN) {
    const remaining = Math.ceil((MIN_COOLDOWN - (now - lastForceUpdate.ts)) / 1000);
    res.setHeader('Content-Type', 'application/json');
    return res.status(429).json({
      success: false,
      message: `Please wait ${remaining}s before forcing another update`,
      cooldown: remaining,
      lastUpdate: new Date(lastForceUpdate.ts).toISOString()
    });
  }
  
  try {
    lastForceUpdate.ts = now;
    newsCache = { data: null, ts: 0 };
    console.log(`[API] Forced news update at ${new Date().toISOString()}`);
    
    const results = await getNews();
    const fetchedCount = results.reduce((sum, src) => sum + src.items.length, 0);
    
    res.setHeader('Content-Type', 'application/json');
    res.json({
      success: true,
      message: 'News force-update completed',
      timestamp: now,
      nextAllowed: new Date(now + MIN_COOLDOWN).toISOString(),
      stats: {
        sources: results.length,
        articles: fetchedCount,
        details: results.map(src => ({
          sport: src.sport,
          count: src.items.length,
          sample: src.items.slice(0, 2).map(item => ({ title: item.title }))
        }))
      }
    });
  } catch (error) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({
      success: false,
      message: 'Force update failed',
      error: error.message,
      timestamp: now
    });
  }
});

// ── News System Status API ───────────────────────────────
app.get('/api/news/status', async (req, res) => {
  const now = Date.now();
  const cacheAge = newsCache.ts ? Math.round((now - newsCache.ts) / 1000) : null;
  const isCacheValid = newsCache.ts && now - newsCache.ts < 6 * 60 * 60 * 1000;
  
  // Calculate source stats
  const sourceStats = NEWS_SOURCES.map(src => {
    const history = newsHistory[src.sport.toLowerCase()] || [];
    const lastFetch = history.length > 0 ? new Date(history[0]?.timestamp).toISOString() : null;
    return {
      sport: src.sport,
      url: src.url,
      historyEntries: history.length,
      lastFetch,
      inCache: newsCache.data?.find(s => s.sport === src.sport)?.items?.length || 0
    };
  });
  
  res.setHeader('Content-Type', 'application/json');
  res.json({
    success: true,
    system: {
      cacheAgeSeconds: cacheAge,
      cacheAgeHuman: cacheAge ? `${Math.floor(cacheAge / 60)}m ${cacheAge % 60}s` : 'Never',
      cacheValid: isCacheValid,
      cacheTimestamp: newsCache.ts ? new Date(newsCache.ts).toISOString() : null,
      nextFetchIn: isCacheValid ? Math.round((6 * 60 * 60 * 1000 - (now - newsCache.ts)) / 1000 / 60) : 0,
      totalHistoryEntries: Object.values(newsHistory).reduce((sum, arr) => sum + arr.length, 0)
    },
    sources: sourceStats,
    endpoints: {
      forceUpdate: '/api/news/force-update',
      adminRefresh: '/admin/news/refresh?key=dev-local-2026',
      history: '/news-history',
      historyJson: '/news-history?sport=cricket&format=json'
    }
  });
});

app.get('/api/news/sources', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    success: true,
    sources: NEWS_SOURCES.map((src, idx) => ({
      id: idx + 1,
      sport: src.sport,
      tag: src.tag,
      url: src.url,
      endpoint: `/news-history?sport=${src.sport.toLowerCase()}`
    })),
    total: NEWS_SOURCES.length
  });
});

// Normalize URLs (strip trailing slash)
app.use((req, res, next) => {
  if (req.path !== '/' && req.path.endsWith('/')) {
    const qs = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    return res.redirect(301, req.path.slice(0, -1) + qs);
  }
  next();
});

// ── Page Data ────────────────────────────────────────────
const pages = {
  '/': {
    title: `${BRAND_NAME} | Home`,
    description: 'Live sports betting insights, casino guides, slots highlights, affiliate resources, and curated sports news on one fast-loading page.',
    keywords: 'sports betting, casino games, slots, affiliate marketing, sports news',
    h1: 'Your Ultimate Gaming Destination',
    badge: '🏆 Y-games',
    socialImage: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1200&q=80',
    content: `
      <div class="hero-desc">Place bets on live sports, play at our casino tables, spin the slots and win big — all on one secure platform with fast payouts and 24/7 support.</div>

      <div class="feature-grid" id="features">
        <div class="feature-card">
          <div class="feature-icon">📊</div>
          <h3>Sportsbook</h3>
          <p>Live odds, match previews, and betting insights across cricket, football, and basketball markets.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🃏</div>
          <h3>Cards Games</h3>
          <p>Real-time table games with live dealers — Blackjack, Roulette, Baccarat and more, streamed 24/7.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🎱</div>
          <h3>Lottery Games</h3>
          <p>Daily lottery draws, instant win tickets, and jackpot games — pick your numbers and play to win big.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🎰</div>
          <h3>Slots Games</h3>
          <p>Hundreds of slot titles — classic reels, video slots, and progressive jackpots with massive payouts.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🤝</div>
          <h3>Affiliate</h3>
          <p>Join our affiliate program, earn competitive commissions and grow your revenue by promoting Y-games.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">📱</div>
          <h3>Get APP</h3>
          <p>Download the Y-games app for iOS &amp; Android — fast bets, live casino, and slots in your pocket, anytime anywhere.</p>
        </div>
      </div>

      {{NEWS_SECTION}}
    `,
    schema: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: BRAND_NAME,
        url: '/',
        description: 'Live sports betting insights, casino guides, slots highlights, affiliate resources, and curated sports news.'
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: BRAND_NAME,
        url: '/',
        logo: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=512&q=80',
        sameAs: [
          'https://x.com/ygames888?s=21',
          'https://www.instagram.com/ygamesofficial?igsh=MWx6ODRhdml6MXBo&utm_source=qr'
        ]
      }
    ]
  }
};

// ── CSS ───────────────────────────────────────────────────
const globalCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #faf5ff;
    --bg2: #ffffff;
    --bg3: #f3e8ff;
    --border: #e9d5ff;
    --accent: #9333ea;
    --accent2: #db2777;
    --text: #1a1a2e;
    --text2: #4b5563;
    --text3: #9ca3af;
    --radius: 12px;
  }

  html { scroll-behavior: smooth; }

  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.7;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    background: rgba(255,255,255,0.92);
    border-bottom: 1px solid var(--border);
    padding: 0 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 60px;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(12px);
  }

  .logo {
    font-size: 1.25rem;
    font-weight: 800;
    background: linear-gradient(90deg, #9333ea 0%, #db2777 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 0;
    letter-spacing: -0.01em;
  }

  .logo-dot { display: none; }

  nav { display: flex; align-items: center; gap: 0.25rem; }

  nav a {
    color: var(--text2);
    text-decoration: none;
    padding: 0.4rem 0.9rem;
    border-radius: 8px;
    font-size: 0.9rem;
    transition: all 0.15s;
  }

  nav a:hover, nav a.active {
    background: var(--bg3);
    color: var(--text);
  }

  .nav-icon {
    width: 18px;
    height: 18px;
    display: block;
  }

  .nav-logo-link {
    padding: 0.4rem 0.6rem;
    color: var(--text2);
  }

  .nav-social {
    padding: 0.4rem 0.6rem;
    color: var(--text2);
    border-radius: 8px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
  }

  .nav-social:hover {
    background: var(--bg3);
    color: var(--text);
  }

  /* ── Carousel ── */
  .hero-carousel {
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
    height: 420px;
  }

  .carousel-track {
    display: flex;
    height: 100%;
    transition: transform 0.6s cubic-bezier(0.4,0,0.2,1);
  }

  .carousel-slide {
    flex: 0 0 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }

  .slide-glow {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .slide-content {
    position: relative;
    z-index: 1;
    text-align: center;
    padding: 2rem;
    max-width: 700px;
  }

  .slide-content h1,
  .slide-content h2 {
    font-size: clamp(2rem, 5vw, 3.2rem);
    font-weight: 800;
    line-height: 1.2;
    margin: 1rem 0 0.8rem;
    background: linear-gradient(135deg, #ffffff 0%, #f9a8d4 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .slide-content p {
    font-size: 1.05rem;
    color: rgba(255,255,255,0.9);
    margin-bottom: 1.5rem;
  }

  .hero-badge {
    display: inline-block;
    background: rgba(219,39,119,0.15);
    border: 1px solid rgba(219,39,119,0.3);
    color: #fbcfe8;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.35rem 1rem;
    border-radius: 20px;
    letter-spacing: 0.03em;
  }

  /* Arrows */
  .carousel-arrow {
    position: absolute;
    top: 50%; transform: translateY(-50%);
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15);
    color: white;
    width: 40px; height: 40px;
    border-radius: 50%;
    font-size: 1.4rem;
    cursor: pointer;
    z-index: 10;
    transition: background 0.2s;
    display: flex; align-items: center; justify-content: center;
    line-height: 1;
  }

  .carousel-arrow:hover { background: rgba(255,255,255,0.18); }
  .carousel-arrow.prev { left: 1rem; }
  .carousel-arrow.next { right: 1rem; }

  /* Dots */
  .carousel-dots {
    position: absolute;
    bottom: 1rem; left: 50%;
    transform: translateX(-50%);
    display: flex; gap: 0.5rem;
    z-index: 10;
  }

  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: rgba(255,255,255,0.3);
    border: none; cursor: pointer;
    transition: all 0.2s;
    padding: 0;
  }

  .dot.active {
    background: white;
    width: 24px;
    border-radius: 4px;
  }

  .hero-desc {
    font-size: 1.05rem;
    color: var(--text2);
    max-width: 560px;
    margin: 0 auto 2rem;
    line-height: 1.7;
  }

  @media (max-width: 640px) {
    .hero-carousel { height: 320px; }
    .carousel-arrow { display: none; }
  }

  main {
    flex: 1;
    max-width: 960px;
    width: 100%;
    margin: 0 auto;
    padding: 2.5rem 1.5rem;
  }

  .feature-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
    margin: 0 auto 2.5rem;
  }

  .feature-card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.4rem 1.5rem;
    transition: border-color 0.2s, transform 0.2s;
  }

  .feature-card:hover {
    border-color: var(--accent);
    transform: translateY(-2px);
  }

  .feature-icon { font-size: 1.8rem; margin-bottom: 0.7rem; }

  .feature-card h3 {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 0.4rem;
  }

  .feature-card p { font-size: 0.88rem; color: var(--text2); line-height: 1.5; }

  .cta-row {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.65rem 1.5rem;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.15s;
  }

  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: white;
    box-shadow: 0 0 20px rgba(147,51,234,0.3);
  }

  .btn-primary:hover {
    background: linear-gradient(135deg, #7e22ce, #be185d);
    box-shadow: 0 0 28px rgba(147,51,234,0.5);
    transform: translateY(-1px);
  }

  .btn-outline {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }

  .btn-outline:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(147,51,234,0.06);
  }

  /* ── Stats ── */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .stat-card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.4rem 1rem;
    text-align: center;
    transition: border-color 0.2s, transform 0.2s;
  }

  .stat-card:hover {
    border-color: var(--accent);
    transform: translateY(-2px);
  }

  .stat-number {
    font-size: 2rem;
    font-weight: 800;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    line-height: 1.1;
    margin-bottom: 0.3rem;
  }

  .stat-label {
    font-size: 0.78rem;
    color: var(--text3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  /* ── News scroll ── */
  .news-sport-block { margin-bottom: 2rem; }

  .sport-header {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 0.8rem;
    letter-spacing: 0.01em;
  }

  .news-scroll-track {
    display: flex;
    gap: 1rem;
    overflow-x: auto;
    padding-bottom: 0.75rem;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .news-scroll-track::-webkit-scrollbar { height: 4px; }
  .news-scroll-track::-webkit-scrollbar-track { background: transparent; }
  .news-scroll-track::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .news-card {
    flex: 0 0 260px;
    scroll-snap-align: start;
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: border-color 0.2s, transform 0.2s;
    display: flex;
    flex-direction: column;
  }

  .news-card:hover {
    border-color: var(--accent);
    transform: translateY(-2px);
  }

  .nc-img { width: 100%; height: 140px; overflow: hidden; flex-shrink: 0; }
  .nc-img img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .nc-img-placeholder {
    background: var(--bg3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2.5rem;
  }

  .nc-body { padding: 1rem; display: flex; flex-direction: column; gap: 0.4rem; flex: 1; }

  .nc-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .nc-meta time { font-size: 0.75rem; color: var(--text3); margin-left: auto; }

  .nc-body h3 { font-size: 0.9rem; font-weight: 700; line-height: 1.4; }

  .nc-body h3 a {
    color: var(--text);
    text-decoration: none;
    transition: color 0.15s;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .nc-body h3 a:hover { color: #a5b4fc; }

  .nc-body p {
    font-size: 0.8rem;
    color: var(--text2);
    line-height: 1.5;
    flex: 1;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .nc-source {
    font-size: 0.75rem;
    color: var(--text3);
    text-decoration: none;
    font-weight: 600;
    transition: color 0.15s;
    margin-top: auto;
  }

  .nc-source:hover { color: var(--accent); }

  /* ── MORE button ── */
  .more-btn {
    margin-top: 0.8rem;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text2);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 0.4rem 1.2rem;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
    display: block;
  }

  .more-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(147,51,234,0.06);
  }

  .more-cards {
    display: none;
    margin-top: 0.8rem;
  }

  .more-cards.open {
    display: flex;
    gap: 1rem;
    overflow-x: auto;
    padding-bottom: 0.75rem;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .more-cards.open::-webkit-scrollbar { height: 4px; }
  .more-cards.open::-webkit-scrollbar-track { background: transparent; }
  .more-cards.open::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .more-cards .news-card {
    flex: 0 0 260px;
    scroll-snap-align: start;
  }

  /* ── Section divider ── */
  .section-divider {
    margin: 2.5rem 0 1.2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .section-title {
    font-size: 1.3rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 0.3rem;
  }

  .section-sub {
    font-size: 0.9rem;
    color: var(--text2);
  }

  /* ── Checklist ── */
  .checklist {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .check-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.9rem;
    color: var(--text2);
  }

  .check-icon { flex-shrink: 0; font-size: 0.9rem; }

  @media (max-width: 768px) {
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
      }

  .info-block {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.8rem 2rem;
    margin-bottom: 1.2rem;
  }

  .info-block h2 {
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 1.2rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .info-block p { color: var(--text2); font-size: 0.95rem; }

  .stack-list { display: flex; flex-direction: column; gap: 0.75rem; }

  .stack-item { display: flex; align-items: center; gap: 1rem; }

  .stack-icon { font-size: 1.4rem; width: 2.2rem; text-align: center; flex-shrink: 0; }

  .stack-item div { display: flex; flex-direction: column; }

  .stack-item strong { font-size: 0.95rem; color: var(--text); font-weight: 600; }

  .stack-item span { font-size: 0.82rem; color: var(--text3); }

  .blog-list { display: flex; flex-direction: column; gap: 1rem; }

  .blog-card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.6rem 2rem;
    transition: border-color 0.2s, transform 0.2s;
  }

  .blog-card:hover {
    border-color: rgba(147,51,234,0.4);
    transform: translateX(4px);
  }

  .blog-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.8rem;
    flex-wrap: wrap;
  }

  .blog-tag {
    background: rgba(147,51,234,0.1);
    color: var(--accent);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 5px;
    border: 1px solid rgba(147,51,234,0.2);
  }

  .blog-meta time { font-size: 0.8rem; color: var(--text3); margin-left: auto; }

  .blog-card h2 { font-size: 1.15rem; font-weight: 700; margin-bottom: 0.6rem; }

  .blog-card h2 a { color: var(--text); text-decoration: none; transition: color 0.15s; }

  .blog-card h2 a:hover { color: var(--accent); }

  .blog-card p { color: var(--text2); font-size: 0.9rem; margin-bottom: 1rem; }

  .read-more {
    font-size: 0.85rem;
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
    transition: color 0.15s;
  }

  .read-more:hover { color: #7e22ce; }

  footer {
    background: linear-gradient(135deg, #581c87 0%, #831843 100%);
    border-top: none;
    padding: 1.5rem 2rem;
    text-align: center;
    color: rgba(255,255,255,0.7);
    font-size: 0.82rem;
  }

  footer a { color: rgba(255,255,255,0.85); text-decoration: none; margin: 0 0.5rem; }
  footer a:hover { color: #f9a8d4; }

  .not-found {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    text-align: center;
    gap: 1rem;
  }

  .not-found .code {
    font-size: 6rem;
    font-weight: 900;
    background: linear-gradient(135deg, #9333ea, #db2777);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    line-height: 1;
  }

  .not-found h1 { font-size: 1.5rem; color: var(--text); }
  .not-found p { color: var(--text2); }

  @media (max-width: 640px) {
    header { padding: 0 1rem; }
    .page-hero { padding: 2.5rem 1rem 2rem; }
    main { padding: 1.5rem 1rem; }
    .feature-grid { grid-template-columns: 1fr; }
    .blog-meta time { margin-left: 0; width: 100%; }
    nav a { padding: 0.4rem 0.6rem; font-size: 0.82rem; }
  }
`;

// ── HTML Template ─────────────────────────────────────────
function renderPage(pagePath, req) {
  const page = pages[pagePath];
  if (!page) return null;

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const canonicalUrl = `${baseUrl}${pagePath}`;
  const socialImageUrl = page.socialImage || `${baseUrl}/social-share.jpg`;
  const schemaData = [
    ...(Array.isArray(page.schema) ? page.schema : [page.schema]).map((entry) => {
      const normalized = { ...entry };
      if (normalized.url === '/') normalized.url = canonicalUrl;
      return normalized;
    }),
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: page.title,
      url: canonicalUrl,
      description: page.description,
      isPartOf: {
        '@type': 'WebSite',
        name: BRAND_NAME,
        url: baseUrl
      }
    }
  ];

  const navLinks = `
    <a href="/" class="nav-logo-link${pagePath === '/' ? ' active' : ''}">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="nav-icon" aria-label="Home"><path fill="currentColor" d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    </a>
    <a href="https://x.com/ygames888?s=21" class="nav-social" aria-label="X (Twitter)" target="_blank" rel="noopener noreferrer">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="nav-icon"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
    </a>
    <a href="https://www.instagram.com/ygamesofficial?igsh=MWx6ODRhdml6MXBo&utm_source=qr" class="nav-social" aria-label="Instagram" target="_blank" rel="noopener noreferrer">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="nav-icon"><path fill="currentColor" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
    </a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Google Tag Manager -->
  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-MMGL32QR');</script>
  <!-- End Google Tag Manager -->

  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>${page.title}</title>
  <meta name="description" content="${page.description}">
  <meta name="robots" content="index, follow">
  <meta name="theme-color" content="#9333ea">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="en" href="${canonicalUrl}">
  <link rel="alternate" hreflang="x-default" href="${canonicalUrl}">
  <link rel="preconnect" href="https://images.unsplash.com" crossorigin>
  <link rel="dns-prefetch" href="https://images.unsplash.com">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%AE%3C/text%3E%3C/svg%3E">

  <meta property="og:type" content="website">
  <meta property="og:title" content="${page.title}">
  <meta property="og:description" content="${page.description}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${socialImageUrl}">
  <meta property="og:image:alt" content="${page.title}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="en_US">
  <meta property="og:site_name" content="${BRAND_NAME}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${page.title}">
  <meta name="twitter:description" content="${page.description}">
  <meta name="twitter:image" content="${socialImageUrl}">
  <meta name="twitter:image:alt" content="${page.title}">

  <script type="application/ld+json">
  ${JSON.stringify(schemaData, null, 2)}
  </script>

  <style>${globalCSS}</style>
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-MMGL32QR"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->

<header>
  <a href="/" class="logo">Y-games</a>
  <nav aria-label="Main navigation">
    ${navLinks}
  </nav>
</header>

<div class="hero-carousel" aria-label="Banner carousel">
  <div class="carousel-track" id="carouselTrack">

    <div class="carousel-slide" style="background: linear-gradient(135deg, #581c87 0%, #9333ea 50%, #db2777 100%)">
      <div class="slide-glow" style="background:radial-gradient(ellipse, rgba(219,39,119,0.35) 0%, transparent 70%)"></div>
      <div class="slide-content">
        <div class="hero-badge">${page.badge}</div>
        <h1>${page.h1}</h1>
        <p>Sports betting, live casino, slots &amp; more — all in one place.</p>
        <a href="#features" class="btn btn-primary">Explore Now →</a>
      </div>
    </div>

    <div class="carousel-slide" style="background: linear-gradient(135deg, #4c1d95 0%, #1e3a8a 100%);">
      <div class="slide-glow" style="background:radial-gradient(ellipse, rgba(16,185,129,0.2) 0%, transparent 70%)"></div>
      <div class="slide-content">
        <div class="hero-badge">⚽ Sportsbook</div>
        <h2>Live Odds on<br>Every Match</h2>
        <p>Cricket, football, basketball — real-time betting with the best odds.</p>
        <a href="#features" class="btn btn-primary" style="background:linear-gradient(135deg,#7c3aed,#db2777);box-shadow:0 0 20px rgba(124,58,237,0.4)">Bet Now →</a>
      </div>
    </div>

    <div class="carousel-slide" style="background: linear-gradient(135deg, #831843 0%, #9333ea 100%);">
      <div class="slide-glow" style="background:radial-gradient(ellipse, rgba(139,92,246,0.2) 0%, transparent 70%)"></div>
      <div class="slide-content">
        <div class="hero-badge">🃏 Cards Games</div>
        <h2>Real Dealers,<br>Real Thrills</h2>
        <p>Baccarat, Blackjack &amp; Roulette — streamed live 24/7.</p>
        <a href="#features" class="btn btn-primary" style="background:linear-gradient(135deg,#9333ea,#db2777);box-shadow:0 0 20px rgba(147,51,234,0.4)">Play Now →</a>
      </div>
    </div>

    <div class="carousel-slide" style="background: linear-gradient(135deg, #7e22ce 0%, #be185d 100%);">
      <div class="slide-glow" style="background:radial-gradient(ellipse, rgba(234,179,8,0.15) 0%, transparent 70%)"></div>
      <div class="slide-content">
        <div class="hero-badge">🎰 Slots &amp; Lottery</div>
        <h2>Spin to Win<br>Jackpots Daily</h2>
        <p>Hundreds of slots &amp; daily lottery draws — your next big win is one spin away.</p>
        <a href="#features" class="btn btn-primary" style="background:linear-gradient(135deg,#db2777,#9333ea);box-shadow:0 0 20px rgba(219,39,119,0.4)">Spin Now →</a>
      </div>
    </div>

  </div>

  <!-- Dots -->
  <div class="carousel-dots" id="carouselDots">
    <button class="dot active" onclick="goSlide(0)"></button>
    <button class="dot" onclick="goSlide(1)"></button>
    <button class="dot" onclick="goSlide(2)"></button>
    <button class="dot" onclick="goSlide(3)"></button>
  </div>

  <!-- Arrows -->
  <button class="carousel-arrow prev" onclick="shiftSlide(-1)" aria-label="Previous">&#8249;</button>
  <button class="carousel-arrow next" onclick="shiftSlide(1)" aria-label="Next">&#8250;</button>
</div>

<script>
  var _cur = 0, _total = 4, _timer;
  function goSlide(n) {
    _cur = (n + _total) % _total;
    document.getElementById('carouselTrack').style.transform = 'translateX(-' + (_cur * 100) + '%)';
    document.querySelectorAll('.dot').forEach(function(d, i){ d.classList.toggle('active', i === _cur); });
    clearInterval(_timer); _timer = setInterval(function(){ goSlide(_cur + 1); }, 5000);
  }
  function shiftSlide(d){ goSlide(_cur + d); }
  _timer = setInterval(function(){ goSlide(_cur + 1); }, 5000);
</script>

<main>
  ${page.content}
</main>

<footer>
  <p>
    © 2026 Y-games ·
    <a href="/sitemap.xml">Sitemap</a> ·
    <a href="/robots.txt">robots.txt</a>
  </p>
</footer>

</body>
</html>`;
}

// ── News HTML builder ─────────────────────────────────────
let _sportCounter = 0;

function buildNewsSection(newsSports) {
  _sportCounter = 0;

  const sections = newsSports.map(({ sport, tag, items }) => {
    if (!items.length) return '';
    const id = `more-${sport.toLowerCase()}`;
    _sportCounter++;

    const makeCard = (item) => {
      const date = item.pub ? new Date(item.pub).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
      const img = item.thumb
        ? `<div class="nc-img"><img src="${item.thumb}" alt="${item.title.replace(/"/g, '')}" loading="lazy" decoding="async" width="240" height="140"></div>`
        : `<div class="nc-img nc-img-placeholder">${tag}</div>`;
      const sourceLabel = sport.includes('TOI') ? 'Times of India' : 'BBC Sport';
      return `
        <article class="news-card">
          ${img}
          <div class="nc-body">
            <div class="nc-meta"><span class="blog-tag">${sport}</span>${date ? `<time>${date}</time>` : ''}</div>
            <h3><a href="${item.link}" target="_blank" rel="noopener noreferrer">${item.title}</a></h3>
            <p>${item.desc.slice(0, 100)}${item.desc.length > 100 ? '…' : ''}</p>
            <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="nc-source">${sourceLabel} ↗</a>
          </div>
        </article>`;
    };

    const displayCards = items.slice(0, 8).map(makeCard).join('');
    // History placeholder - future: add "View past week" link
    const historyLink = `<!-- 历史记录功能开发中 -->`;

    return `
      <div class="news-sport-block">
        <div class="sport-header">${tag} ${sport} <a href="/news-history?sport=${sport.toLowerCase()}" style="font-size: 0.7rem; color: var(--text3); margin-left: 0.5rem; text-decoration: none;" title="View past week history">📜 History</a></div>
        <div class="news-scroll-track">${displayCards}</div>
        ${historyLink}
      </div>`;
  }).join('');

  return `
    <div class="section-divider">
      <h2 class="section-title">📰 News</h2>
      <p class="section-sub">Live sports headlines from BBC Sport — Cricket, Football &amp; Basketball.</p>
    </div>
    ${sections}
    <script>
      function toggleMore(id, btn) {
        var el = document.getElementById(id);
        var open = el.classList.toggle('open');
        btn.textContent = open ? 'LESS ▴' : 'MORE ▾';
      }
    </script>`;
}

// ── Routes ────────────────────────────────────────────────
Object.keys(pages).forEach(path => {
  app.get(path, async (req, res) => {
    let html = renderPage(path, req);
    if (html && html.includes('{{NEWS_SECTION}}')) {
      const news = await getNews();
      html = html.replace('{{NEWS_SECTION}}', buildNewsSection(news));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Robots-Tag', 'index, follow');
    res.send(html);
  });
});

// ── sitemap.xml ───────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const now = new Date().toISOString().split('T')[0];

  const urls = [
    {
      loc: `${baseUrl}/`,
      lastmod: now,
      changefreq: 'daily',
      priority: '1.0'
    }
  ];

  const sitemapXml = urls.map(({ loc, lastmod, changefreq, priority }) => `
  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join('');

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
  res.setHeader('X-Robots-Tag', 'index, follow');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapXml}
</urlset>`);
});

// ── robots.txt ────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
  res.setHeader('X-Robots-Tag', 'index, follow');
  res.send(`User-agent: *
Allow: /
Disallow: /admin/
Disallow: /private/
Crawl-delay: 5
Host: ${req.get('host')}

Sitemap: ${baseUrl}/sitemap.xml
`);
});

// ── News History Page ─────────────────────────────────────
app.get('/news-history', (req, res) => {
  const { sport = 'cricket', format } = req.query;
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  // JSON API mode
  if (format === 'json') {
    const sportKey = sport.toLowerCase();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!newsHistory[sportKey]) {
      return res.status(404).json({ success: false, message: `Sport not found.` });
    }
    const history = getHistory(sport, 50);
    return res.json({
      success: true, sport: sportKey,
      count: history.length,
      history: history.map(e => ({
        timestamp: e.timestamp,
        date: new Date(e.timestamp).toISOString(),
        itemsCount: e.items.length,
        items: e.items.map(i => ({ title: i.title, link: i.link, pubDate: i.pub, thumbnail: i.thumb || null }))
      }))
    });
  }

  const sportKey = sport.toLowerCase();
  const sportMeta = {
    cricket:    { tag: '🏏', label: 'Cricket' },
    football:   { tag: '⚽', label: 'Football' },
    basketball: { tag: '🏀', label: 'Basketball' },
  };

  const tabs = Object.entries(sportMeta).map(([key, { tag, label }]) => {
    const active = key === sportKey;
    const count = (newsHistory[key] || []).length;
    return `<a href="/news-history?sport=${key}" class="hist-tab${active ? ' active' : ''}">${tag} ${label} <span class="hist-count">${count}</span></a>`;
  }).join('');

  const history = getHistory(sportKey, 50);
  const meta = sportMeta[sportKey] || { tag: '📰', label: sportKey };

  const buildHistoryCards = (entries) => {
    if (!entries.length) {
      return `<div class="hist-empty">
        <div style="font-size:3rem;margin-bottom:1rem;">📭</div>
        <p>No history yet. News data will be recorded after the first visit to the homepage.</p>
        <a href="/" class="btn btn-primary" style="margin-top:1rem;display:inline-flex;">← Back to Home</a>
      </div>`;
    }

    return entries.map((entry, idx) => {
      const date = new Date(entry.timestamp);
      const dateStr = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const isLatest = idx === 0;

      const cards = entry.items.map(item => {
        const pubDate = item.pub ? new Date(item.pub).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
        const img = item.thumb
          ? `<div class="nc-img"><img src="${item.thumb}" alt="${item.title.replace(/"/g,'')}" loading="lazy" decoding="async" width="240" height="130"></div>`
          : `<div class="nc-img nc-img-placeholder">${meta.tag}</div>`;
        const sourceLabel = meta.label.includes('TOI') ? 'Times of India' : 'BBC Sport';
        return `
          <article class="news-card">
            ${img}
            <div class="nc-body">
              <div class="nc-meta"><span class="blog-tag">${meta.label}</span>${pubDate ? `<time>${pubDate}</time>` : ''}</div>
              <h3><a href="${item.link}" target="_blank" rel="noopener noreferrer">${item.title}</a></h3>
              <p>${(item.desc||'').slice(0,100)}${(item.desc||'').length>100?'…':''}</p>
              <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="nc-source">${sourceLabel} ↗</a>
            </div>
          </article>`;
      }).join('');

      return `
        <div class="hist-batch">
          <div class="hist-batch-header">
            <span class="hist-badge${isLatest ? ' latest' : ''}">
              ${isLatest ? '🔴 Latest' : `#${idx + 1}`}
            </span>
            <span class="hist-date">🕐 ${dateStr}</span>
            <span class="hist-items-count">${entry.items.length} articles</span>
          </div>
          <div class="news-scroll-track">${cards}</div>
        </div>`;
    }).join('');
  };

  const historyHTML = buildHistoryCards(history);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>News History | Y-games</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #faf5ff; --bg2: #ffffff; --bg3: #f3e8ff;
      --border: #e9d5ff; --accent: #9333ea; --accent2: #db2777;
      --text: #1a1a2e; --text2: #4b5563; --text3: #9ca3af; --radius: 12px;
    }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.7; min-height: 100vh; display: flex; flex-direction: column; }
    header { background: rgba(255,255,255,0.92); border-bottom: 1px solid var(--border); padding: 0 2rem; display: flex; align-items: center; justify-content: space-between; height: 60px; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(12px); }
    .logo { font-size: 1.25rem; font-weight: 800; background: linear-gradient(90deg, #9333ea 0%, #db2777 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; text-decoration: none; display: flex; align-items: center; letter-spacing: -0.01em; }
    .logo-dot { display: none; }
    main { flex: 1; max-width: 1060px; width: 100%; margin: 0 auto; padding: 2rem 1.5rem; }
    .page-title { font-size: 1.6rem; font-weight: 800; margin-bottom: 0.4rem; }
    .page-sub { color: var(--text2); font-size: 0.9rem; margin-bottom: 1.8rem; }
    /* Tabs */
    .hist-tabs { display: flex; gap: 0.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .hist-tab { display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1.1rem; border-radius: 8px; font-size: 0.9rem; font-weight: 600; text-decoration: none; color: var(--text2); background: var(--bg2); border: 1px solid var(--border); transition: all 0.15s; }
    .hist-tab:hover { border-color: var(--accent); color: var(--accent); }
    .hist-tab.active { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: white; border-color: var(--accent); }
    .hist-count { background: rgba(255,255,255,0.15); border-radius: 20px; padding: 0.1rem 0.5rem; font-size: 0.75rem; }
    /* Batch */
    .hist-batch { margin-bottom: 2.5rem; }
    .hist-batch-header { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
    .hist-badge { font-size: 0.78rem; font-weight: 700; padding: 0.25rem 0.7rem; border-radius: 20px; background: var(--bg3); border: 1px solid var(--border); color: var(--text2); }
    .hist-badge.latest { background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.4); color: #fca5a5; }
    .hist-date { font-size: 0.82rem; color: var(--text3); }
    .hist-items-count { font-size: 0.78rem; color: var(--text3); margin-left: auto; }
    /* News cards (reuse main site styles) */
    .news-scroll-track { display: flex; gap: 1rem; overflow-x: auto; padding-bottom: 0.75rem; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    .news-scroll-track::-webkit-scrollbar { height: 4px; }
    .news-scroll-track::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .news-card { flex: 0 0 240px; scroll-snap-align: start; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; transition: border-color 0.2s; }
    .news-card:hover { border-color: var(--accent); }
    .nc-img { width: 100%; height: 130px; overflow: hidden; flex-shrink: 0; }
    .nc-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .nc-img-placeholder { background: var(--bg3); display: flex; align-items: center; justify-content: center; font-size: 2rem; }
    .nc-body { padding: 0.9rem; display: flex; flex-direction: column; gap: 0.35rem; flex: 1; }
    .nc-meta { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .nc-meta time { font-size: 0.72rem; color: var(--text3); margin-left: auto; }
    .blog-tag { background: rgba(147,51,234,0.1); color: var(--accent); font-size: 0.72rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 4px; border: 1px solid rgba(147,51,234,0.2); }
    .nc-body h3 { font-size: 0.85rem; font-weight: 700; line-height: 1.4; }
    .nc-body h3 a { color: var(--text); text-decoration: none; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .nc-body h3 a:hover { color: var(--accent); }
    .nc-body p { font-size: 0.78rem; color: var(--text2); line-height: 1.5; flex: 1; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .nc-source { font-size: 0.72rem; color: var(--text3); text-decoration: none; font-weight: 600; transition: color 0.15s; margin-top: auto; }
    .nc-source:hover { color: var(--accent2); }
    /* Empty */
    .hist-empty { text-align: center; padding: 4rem 2rem; color: var(--text2); }
    /* Divider */
    .hist-divider { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
    /* Back btn */
    .btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.6rem 1.4rem; border-radius: 8px; font-size: 0.9rem; font-weight: 600; text-decoration: none; transition: all 0.15s; }
    .btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-outline:hover { border-color: var(--accent); color: var(--accent); }
    .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: white; border: none; }
    footer { background: linear-gradient(135deg, #581c87 0%, #831843 100%); border-top: none; padding: 1.2rem 2rem; text-align: center; color: rgba(255,255,255,0.7); font-size: 0.82rem; }
    footer a { color: rgba(255,255,255,0.85); text-decoration: none; margin: 0 0.5rem; }
    @media (max-width: 640px) { main { padding: 1.2rem 1rem; } header { padding: 0 1rem; } }
  </style>
</head>
<body>
<header>
  <a href="/" class="logo">Y-games</a>
  <a href="/" class="btn btn-outline" style="font-size:0.85rem;">← Back to Home</a>
</header>
<main>
  <h1 class="page-title">📜 News History</h1>
  <p class="page-sub">News records from the past 7 days · Updated every 6 hours · Records older than 7 days are automatically removed</p>

  <div class="hist-tabs">${tabs}</div>

  ${historyHTML}
</main>
<footer>
  © 2026 Y-games ·
  <a href="/">Home</a> ·
  <a href="/sitemap.xml">Sitemap</a> ·
  <a href="/news-history?sport=cricket&format=json">JSON API</a>
</footer>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(html);
});

// ── 404 page ──────────────────────────────────────────────
app.use((req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 | ${BRAND_NAME}</title>
  <meta name="robots" content="noindex, nofollow">
  <link rel="canonical" href="${baseUrl}${req.path}">
  <style>${globalCSS}</style>
</head>
<body>
<header>
  <a href="/" class="logo">${BRAND_NAME}</a>
</header>
<main>
  <section class="not-found">
    <div class="code">404</div>
    <h1>Page Not Found</h1>
    <p>The page you requested could not be found. Try going back to the homepage.</p>
    <a href="/" class="btn btn-primary">Back to Home</a>
  </section>
</main>
<footer>
  <p>© 2026 ${BRAND_NAME} · <a href="/sitemap.xml">Sitemap</a> · <a href="/robots.txt">robots.txt</a></p>
</footer>
</body>
</html>`;
  res.status(404);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.send(html);
});

function startServer() {
  return app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`📄 Sitemap: http://localhost:${PORT}/sitemap.xml`);
    console.log(`🤖 robots.txt: http://localhost:${PORT}/robots.txt`);

    // 启动时立即预热新闻缓存
    getNews().then(() => console.log('[Init] News cache warmed up on startup'));

    // 每6小时自动刷新
    setInterval(() => {
      newsCache = { data: null, ts: 0 }; // 清除旧缓存
      getNews().then(() => console.log('[Auto] News cache refreshed'));
    }, 6 * 60 * 60 * 1000);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.startServer = startServer;
