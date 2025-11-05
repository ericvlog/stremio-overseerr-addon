import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 7000;
const SERVER_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;

// Serve static files from public folder
app.use(express.static("public"));

// ─── Parse Stremio ID formats ───────────────────
function parseStremioId(id, type) {
    console.log(`[PARSER] Parsing ID: ${id} for type: ${type}`);

    // Movie format: "tt1234567"
    if (type === 'movie' && id.startsWith('tt')) {
        return { imdbId: id, season: null, episode: null };
    }

    // TV Show formats:
    // Series: "tt1234567"
    // Episode: "tt1234567:1:1" or "tt1234567:1:2"
    if (type === 'series') {
        if (id.includes(':')) {
            const parts = id.split(':');
            if (parts.length === 3) {
                return {
                    imdbId: parts[0],
                    season: parseInt(parts[1]),
                    episode: parseInt(parts[2])
                };
            }
        } else if (id.startsWith('tt')) {
            return { imdbId: id, season: null, episode: null };
        }
    }

    // TMDB ID format (just numbers)
    if (/^\d+$/.test(id)) {
        return { tmdbId: parseInt(id), season: null, episode: null };
    }

    console.log(`[PARSER] Unsupported ID format: ${id}`);
    return null;
}

// ─── Configuration Decoding ──────────────
function decodeConfig(configString) {
    try {
        const configJson = Buffer.from(configString, 'base64').toString('utf8');
        const config = JSON.parse(configJson);

        if (!config.tmdbKey || !config.overseerrUrl || !config.overseerrApi) {
            throw new Error('Missing required configuration fields');
        }

        return config;
    } catch (error) {
        console.error('[CONFIG] Error decoding configuration:', error.message);
        return null;
    }
}

// ─── PROPER STREMIO STREAM FORMAT ──────────────────
function createStreamObject(title, url, type, tmdbId, season = null) {
    // This is the CRITICAL part - proper Stremio stream format
    const stream = {
        title: title,
        url: url,
        name: "Overseerr", // Stream name shown in Stremio
        
        // Stremio-specific properties that make it work
        behaviorHints: {
            // Mark as not web-ready (it's a request stream, not playable video)
            notWebReady: true,
            // Group binge shows together
            bingeGroup: `overseerr-${tmdbId}${season ? `-s${season}` : ''}`,
            // Indicate this is a custom action, not a video stream
            proxyHeaders: {
                "request-type": "overseerr"
            }
        },
        
        // Additional metadata that helps Stremio
        type: "other", // Not a direct video stream
        description: "Request this content in Overseerr"
    };

    return stream;
}

// ─── Make Overseerr Request (SERVERLESS COMPATIBLE) ────────────
async function makeOverseerrRequest(tmdbId, type, mediaName, seasonNumber = null, requestType = 'season', userConfig = null) {
    try {
        console.log(`[BACKGROUND] Making ${requestType} request for ${type} TMDB ID: ${tmdbId} - ${mediaName}`);

        const requestBody = {
            mediaId: parseInt(tmdbId),
            mediaType: type === 'movie' ? 'movie' : 'tv'
        };

        // Handle seasons for TV shows
        if (type === 'series') {
            if (requestType === 'season' && seasonNumber !== null) {
                requestBody.seasons = [seasonNumber];
            } else if (requestType === 'series') {
                // For full series, don't specify seasons - Overseerr will handle it
                console.log(`[BACKGROUND] Full series request - no specific seasons`);
            }
        }

        const overseerrUrl = userConfig ? userConfig.overseerrUrl : process.env.OVERSEERR_URL;
        const overseerrApi = userConfig ? userConfig.overseerrApi : process.env.OVERSEERR_API;

        if (!overseerrUrl || !overseerrApi) {
            console.error(`[BACKGROUND] Missing Overseerr configuration`);
            return;
        }

        const response = await fetch(
            `${overseerrUrl}/api/v1/request`,
            {
                method: 'POST',
                headers: {
                    'X-Api-Key': overseerrApi,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            }
        );

        if (response.ok) {
            const data = await response.json();
            console.log(`[BACKGROUND] ✅ Success: ${mediaName} - Request ID: ${data.id}`);
        } else {
            const errorText = await response.text();
            console.error(`[BACKGROUND] ❌ Failed: ${mediaName} - ${errorText}`);
        }
    } catch (error) {
        console.error(`[BACKGROUND] ❌ Error: ${mediaName} - ${error.message}`);
    }
}

// ─── Configured Manifest ───────────────────
app.get("/configured/:config/manifest.json", (req, res) => {
    const { config } = req.params;

    console.log(`[MANIFEST] Configured manifest requested`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        id: `org.overseerr.addon.${config}`,
        version: "1.0.0",
        name: "Overseerr Requests",
        description: "Request movies and shows through Overseerr",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"],
        background: "#141414",
        logo: "https://overseerr.dev/images/logo.png",
        contactEmail: "support@example.com"
    });
});

// ─── Configured Stream Endpoint (PROPER STREMIO FORMAT) ───
app.get("/configured/:config/stream/:type/:id.json", async (req, res) => {
    const { config, type, id } = req.params;

    console.log(`[STREAM] Configured stream requested for ${type} ID: ${id}`);

    // Set CORS headers for Stremio
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        // Decode configuration
        const userConfig = decodeConfig(config);
        if (!userConfig) {
            console.log(`[STREAM] Invalid configuration`);
            return res.json({ streams: [] });
        }

        // Parse the Stremio ID format
        const parsedId = parseStremioId(id, type);
        if (!parsedId) {
            console.log(`[STREAM] Unsupported ID format`);
            return res.json({ streams: [] });
        }

        let tmdbId;
        let title = `ID: ${id}`;
        let season = parsedId.season;
        let episode = parsedId.episode;

        // Convert IMDb to TMDB if needed
        if (parsedId.imdbId) {
            const tmdbResponse = await fetch(
                `https://api.themoviedb.org/3/find/${parsedId.imdbId}?api_key=${userConfig.tmdbKey}&external_source=imdb_id`
            );
            
            if (!tmdbResponse.ok) {
                console.log(`[STREAM] TMDB lookup failed for IMDb: ${parsedId.imdbId}`);
                return res.json({ streams: [] });
            }

            const tmdbData = await tmdbResponse.json();
            const result = type === 'movie' ? tmdbData.movie_results?.[0] : tmdbData.tv_results?.[0];
            
            if (result) {
                tmdbId = result.id;
                title = result.title || result.name;
                console.log(`[STREAM] Converted IMDb ${parsedId.imdbId} to TMDB ${tmdbId} - ${title}`);
            } else {
                console.log(`[STREAM] No TMDB result for IMDb: ${parsedId.imdbId}`);
                return res.json({ streams: [] });
            }
        } else if (parsedId.tmdbId) {
            tmdbId = parsedId.tmdbId;
        }

        if (!tmdbId) {
            console.log(`[STREAM] No TMDB ID found`);
            return res.json({ streams: [] });
        }

        // ─── BUILD STREAMS ARRAY (CRITICAL PART) ───
        let streams = [];

        if (type === 'movie') {
            // Movie - single request option
            const videoUrl = `${SERVER_URL}/configured/${config}/video/movie/${tmdbId}?title=${encodeURIComponent(title)}`;
            
            streams.push(createStreamObject(
                `📥 Request "${title}" in Overseerr`,
                videoUrl,
                'movie',
                tmdbId
            ));

        } else if (type === 'series') {
            if (season !== null && episode !== null) {
                // Episode page - show multiple options
                
                // Option 1: Request This Season
                const seasonUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&request_type=season`;
                streams.push(createStreamObject(
                    `📥 Request Season ${season} of "${title}"`,
                    seasonUrl,
                    'series',
                    tmdbId,
                    season
                ));

                // Option 2: Request Full Series
                const seriesUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&request_type=series`;
                streams.push(createStreamObject(
                    `📥 Request All Seasons of "${title}"`,
                    seriesUrl,
                    'series', 
                    tmdbId
                ));
            } else {
                // Series overview page
                const seriesUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&request_type=series`;
                streams.push(createStreamObject(
                    `📥 Request "${title}" in Overseerr`,
                    seriesUrl,
                    'series',
                    tmdbId
                ));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: ${title}`);
        
        // Log each stream for debugging
        streams.forEach((stream, index) => {
            console.log(`  ${index + 1}. ${stream.title}`);
        });

        // RETURN IN PROPER STREMIO FORMAT
        res.json({ 
            streams: streams,
            // Add cache hints for better performance
            cacheMaxAge: 3600,
            staleRevalidate: 3600,
            staleError: 86400
        });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        // Always return valid Stremio format, even on error
        res.json({ streams: [] });
    }
});

// ─── Video Endpoint (TRIGGERS REQUEST + REDIRECTS) ───────
app.get("/configured/:config/video/:type/:tmdbId", async (req, res) => {
    const { config, type, tmdbId } = req.params;
    const { title, season, request_type } = req.query;
    const mediaName = title || 'Unknown';

    console.log(`[VIDEO] Video endpoint called for ${type} ${tmdbId} - ${mediaName}`,
        season ? `Season ${season}` : '',
        request_type ? `Type: ${request_type}` : ''
    );

    // Decode configuration
    const userConfig = decodeConfig(config);
    if (!userConfig) {
        console.log(`[VIDEO] Invalid configuration`);
        return res.status(400).send('Invalid configuration');
    }

    // Trigger background request (fire and forget)
    const seasonNum = season ? parseInt(season) : null;
    const reqType = request_type || (type === 'movie' ? 'movie' : 'season');

    makeOverseerrRequest(tmdbId, type, mediaName, seasonNum, reqType, userConfig)
        .catch(err => console.error(`[BACKGROUND] Unhandled error: ${err.message}`));

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    // Redirect to a waiting video - USING RELATIVE PATH for Vercel compatibility
    console.log(`[VIDEO] Redirecting to wait video for ${mediaName}`);
    
    // Use relative URL that works on both local and Vercel
    res.redirect('/wait.mp4');
});

// ─── Original Manifest (for default addon) ───────────────
app.get("/manifest.json", (req, res) => {
    console.log(`[MANIFEST] Default manifest requested`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        id: "org.overseerr.addon",
        version: "1.0.0", 
        name: "Overseerr Requests",
        description: "Request movies and shows through Overseerr - configure your instance",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"],
        background: "#141414",
        logo: "https://overseerr.dev/images/logo.png"
    });
});

// ─── Original Stream Endpoint ───────
app.get("/stream/:type/:id.json", async (req, res) => {
    const { type, id } = req.params;

    console.log(`[STREAM] Default stream requested for ${type} ID: ${id}`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const parsedId = parseStremioId(id, type);
        if (!parsedId) {
            return res.json({ streams: [] });
        }

        let tmdbId;
        let title = `ID: ${id}`;

        // Convert IMDb to TMDB if needed
        if (parsedId.imdbId && process.env.TMDB_API_KEY) {
            const tmdbResponse = await fetch(
                `https://api.themoviedb.org/3/find/${parsedId.imdbId}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id`
            );
            
            if (tmdbResponse.ok) {
                const tmdbData = await tmdbResponse.json();
                const result = type === 'movie' ? tmdbData.movie_results?.[0] : tmdbData.tv_results?.[0];
                if (result) {
                    tmdbId = result.id;
                    title = result.title || result.name;
                }
            }
        } else if (parsedId.tmdbId) {
            tmdbId = parsedId.tmdbId;
        }

        if (!tmdbId) {
            return res.json({ streams: [] });
        }

        let streams = [];

        if (type === 'movie') {
            const videoUrl = `${SERVER_URL}/video/movie/${tmdbId}?title=${encodeURIComponent(title)}`;
            streams.push(createStreamObject(
                `📥 Request "${title}" in Overseerr`,
                videoUrl,
                'movie',
                tmdbId
            ));
        } else if (type === 'series') {
            if (parsedId.season !== null) {
                const seasonUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${parsedId.season}&request_type=season`;
                streams.push(createStreamObject(
                    `📥 Request Season ${parsedId.season} of "${title}"`,
                    seasonUrl,
                    'series',
                    tmdbId,
                    parsedId.season
                ));

                const seriesUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${parsedId.season}&request_type=series`;
                streams.push(createStreamObject(
                    `📥 Request All Seasons of "${title}"`,
                    seriesUrl,
                    'series',
                    tmdbId
                ));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for default addon`);
        res.json({ streams: streams });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        res.json({ streams: [] });
    }
});

// ─── Original Video Endpoint ────────────
app.get("/video/:type/:tmdbId", async (req, res) => {
    const { type, tmdbId } = req.params;
    const { title, season, request_type } = req.query;
    const mediaName = title || 'Unknown';

    console.log(`[VIDEO] Default video endpoint for ${type} ${tmdbId} - ${mediaName}`);

    // Only trigger if we have environment variables
    if (process.env.OVERSEERR_URL && process.env.OVERSEERR_API) {
        const seasonNum = season ? parseInt(season) : null;
        const reqType = request_type || (type === 'movie' ? 'movie' : 'season');

        makeOverseerrRequest(tmdbId, type, mediaName, seasonNum, reqType)
            .catch(err => console.error(`[BACKGROUND] Unhandled error: ${err.message}`));
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    // Redirect to wait video
    res.redirect('/wait.mp4');
});

// ─── Serve wait video from public folder ────────
app.get("/wait.mp4", (req, res) => {
    const localVideoPath = path.join(__dirname, "public", "wait.mp4");
    
    if (fs.existsSync(localVideoPath)) {
        res.sendFile(localVideoPath);
    } else {
        // Fallback to CDN
        res.redirect('https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4');
    }
});

// ─── Configuration Testing Endpoint ─────────────────
app.post("/api/test-configuration", express.json(), async (req, res) => {
    try {
        const { tmdbKey, overseerrUrl, overseerrApi } = req.body;

        if (!tmdbKey || !overseerrUrl || !overseerrApi) {
            return res.json({ success: false, error: 'Missing required fields' });
        }

        const results = [];

        // Test TMDB API
        try {
            const tmdbResponse = await fetch(`https://api.themoviedb.org/3/movie/550?api_key=${tmdbKey}`);
            if (tmdbResponse.ok) {
                results.push({ service: 'TMDB', status: 'success', message: 'API key is valid' });
            } else {
                results.push({ service: 'TMDB', status: 'error', message: `API key invalid (HTTP ${tmdbResponse.status})` });
            }
        } catch (error) {
            results.push({ service: 'TMDB', status: 'error', message: `Connection failed: ${error.message}` });
        }

        // Test Overseerr API
        try {
            const normalizedUrl = overseerrUrl.replace(/\/$/, '');
            const overseerrResponse = await fetch(`${normalizedUrl}/api/v1/user`, {
                headers: { 'X-Api-Key': overseerrApi }
            });

            if (overseerrResponse.ok) {
                results.push({ service: 'Overseerr', status: 'success', message: 'URL and API key are valid' });
            } else {
                results.push({ service: 'Overseerr', status: 'error', message: `Connection failed (HTTP ${overseerrResponse.status})` });
            }
        } catch (error) {
            results.push({ service: 'Overseerr', status: 'error', message: `Connection failed: ${error.message}` });
        }

        const allSuccess = results.every(result => result.status === 'success');

        res.json({
            success: allSuccess,
            results: results
        });

    } catch (error) {
        res.json({
            success: false,
            error: `Server error: ${error.message}`
        });
    }
});

// ─── Health Check ──────────────────
app.get("/health", (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'Vercel Serverless Ready',
        version: '1.0.0'
    });
});

// Handle CORS preflight requests
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.sendStatus(200);
});

// ─── Configuration Page ────────────────────
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Stremio Overseerr Addon</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f0f0f; color: #fff; margin: 0; padding: 20px; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: #1a1a1a; padding: 20px; border-radius: 8px; margin: 20px 0; }
            input, button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 4px; border: 1px solid #333; }
            input { background: #2a2a2a; color: #fff; }
            button { background: #28a745; color: white; border: none; cursor: pointer; }
            button:hover { background: #34d058; }
            .addon-url { background: #2a2a2a; padding: 15px; border-radius: 4px; word-break: break-all; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎬 Stremio Overseerr Addon</h1>
            
            <div class="card">
                <h2>🔑 Configure Your Addon</h2>
                <input type="text" id="tmdbKey" placeholder="TMDB API Key" required>
                <input type="text" id="overseerrUrl" placeholder="Overseerr URL (https://...)" required>
                <input type="text" id="overseerrApi" placeholder="Overseerr API Key" required>
                <button onclick="generateAddon()">Generate Addon URL</button>
            </div>

            <div class="card" id="result" style="display:none">
                <h2>📦 Your Addon URL</h2>
                <div class="addon-url" id="addonUrl"></div>
                <p>Install this URL in Stremio as a community addon</p>
                <button onclick="installInStremio()">Install in Stremio</button>
            </div>

            <div class="card">
                <h3>🔗 Quick Tests</h3>
                <a href="/manifest.json" target="_blank">Default Manifest</a> • 
                <a href="/stream/movie/tt0133093.json" target="_blank">Test Movie Stream</a> • 
                <a href="/stream/series/tt0944947:1:1.json" target="_blank">Test TV Stream</a>
            </div>
        </div>

        <script>
            function generateAddon() {
                const config = {
                    tmdbKey: document.getElementById('tmdbKey').value,
                    overseerrUrl: document.getElementById('overseerrUrl').value,
                    overseerrApi: document.getElementById('overseerrApi').value
                };

                if (!config.tmdbKey || !config.overseerrUrl || !config.overseerrApi) {
                    alert('Please fill all fields');
                    return;
                }

                const configJson = JSON.stringify(config);
                const configBase64 = btoa(unescape(encodeURIComponent(configJson)));
                const addonUrl = window.location.origin + '/configured/' + configBase64 + '/manifest.json';

                document.getElementById('addonUrl').textContent = addonUrl;
                document.getElementById('result').style.display = 'block';
                window.generatedAddonUrl = addonUrl;
            }

            function installInStremio() {
                if (window.generatedAddonUrl) {
                    const stremioUrl = 'stremio://' + window.generatedAddonUrl.replace(/^https?:\\/\\//, '');
                    window.location.href = stremioUrl;
                }
            }
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

// ─── Start Server ───────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Stremio Overseerr Addon running at: ${SERVER_URL}`);
    console.log(`📋 User-specific addons: ${SERVER_URL}/configured/{config}/manifest.json`);
    console.log(`🎬 Test streams: ${SERVER_URL}/stream/movie/tt0133093.json`);
    console.log(`🚀 Vercel Serverless Ready`);
});
