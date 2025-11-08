import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 7000;
const SERVER_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;

// Store pending requests to avoid duplicates - IMPROVED DEDUPLICATION
const pendingRequests = new Map();
const REQUEST_TTL = 30 * 60 * 1000; // 30 minutes TTL

// ─── Parse Stremio ID formats ───────────────────
function parseStremioId(id, type) {
    console.log(`[PARSER] Parsing ID: ${id} for type: ${type}`);

    if (type === 'movie' && id.startsWith('tt')) {
        return { imdbId: id, season: null, episode: null };
    }

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

    if (/^\d+$/.test(id)) {
        return { tmdbId: parseInt(id), season: null, episode: null };
    }

    console.log(`[PARSER] Unsupported ID format: ${id}`);
    return null;
}

// ─── Configuration Decoding ──────────────
function decodeConfig(configString) {
    try {
        // Add padding if needed for base64
        let paddedConfig = configString;
        while (paddedConfig.length % 4 !== 0) {
            paddedConfig += '=';
        }

        const configJson = Buffer.from(paddedConfig, 'base64').toString('utf8');
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

// ─── Make Overseerr Request ────────────
async function makeOverseerrRequest(tmdbId, type, mediaName, seasonNumber = null, requestType = 'season', userConfig = null) {
    try {
        console.log(`[OVERSEERR] Making ${requestType} request for ${type} TMDB ID: ${tmdbId} - "${mediaName}"`);

        const requestBody = {
            mediaId: parseInt(tmdbId),
            mediaType: type === 'movie' ? 'movie' : 'tv'
        };

        if (type === 'series' && requestType === 'season' && seasonNumber !== null) {
            requestBody.seasons = [seasonNumber];
        }

        const overseerrUrl = userConfig ? userConfig.overseerrUrl : process.env.OVERSEERR_URL;
        const overseerrApi = userConfig ? userConfig.overseerrApi : process.env.OVERSEERR_API;

        if (!overseerrUrl || !overseerrApi) {
            console.error(`[OVERSEERR] Missing Overseerr configuration`);
            return { success: false, error: "Missing Overseerr configuration" };
        }

        // Normalize URL - remove trailing slashes
        const normalizedUrl = overseerrUrl.replace(/\/$/, '');
        
        console.log(`[OVERSEERR] Sending to: ${normalizedUrl}/api/v1/request`);
        console.log(`[OVERSEERR] Request body:`, JSON.stringify(requestBody));

        const response = await fetch(
            `${normalizedUrl}/api/v1/request`,
            {
                method: 'POST',
                headers: {
                    'X-Api-Key': overseerrApi,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Stremio-Overseerr-Addon/1.0.0'
                },
                body: JSON.stringify(requestBody)
            }
        );

        console.log(`[OVERSEERR] Response status: ${response.status} ${response.statusText}`);

        if (response.ok) {
            const data = await response.json();
            console.log(`[OVERSEERR] ✅ SUCCESS: "${mediaName}" - Request ID: ${data.id}`);
            return { 
                success: true, 
                requestId: data.id, 
                data: data,
                message: `Request submitted successfully (ID: ${data.id})`
            };
        } else {
            const errorText = await response.text();
            console.error(`[OVERSEERR] ❌ FAILED: "${mediaName}" - Status: ${response.status}, Error: ${errorText}`);
            return { 
                success: false, 
                error: errorText,
                status: response.status,
                statusText: response.statusText,
                message: `Request failed: ${response.status} ${response.statusText}`
            };
        }
    } catch (error) {
        console.error(`[OVERSEERR] ❌ NETWORK ERROR: "${mediaName}" - ${error.message}`);
        return { 
            success: false, 
            error: error.message,
            code: error.code,
            message: `Network error: ${error.message}`
        };
    }
}

// ─── STREAM FORMAT USING LONGER VIDEO ──────────────────
function createStreamObject(title, type, tmdbId, season = null, episode = null, config = '') {
    // Build a stream object that points to our /test-video endpoint on this server.
    // The actual Overseerr request will be performed when the player fetches this URL (on click/playback).
    let streamTitle;
    if (type === 'movie') {
        streamTitle = `Request "${title}"`;
    } else if (season && episode) {
        streamTitle = `Request S${season}E${episode} of "${title}"`;
    } else if (season) {
        streamTitle = `Request Season ${season} of "${title}"`;
    } else {
        streamTitle = `Request "${title}"`;
    }

    const params = new URLSearchParams({
        config: config || '',
        type: type,
        tmdbId: tmdbId,
        title: title,
        season: season || '',
        episode: episode || ''
    });

    const waitVideoUrl = `${SERVER_URL}/test-video?${params.toString()}`;

    return {
        name: "Overseerr",
        title: streamTitle,
        url: waitVideoUrl,
        behaviorHints: {
            notWebReady: false,
            bingeGroup: `overseerr-${type}-${tmdbId}`
        }
    };
}

// ─── Configured Manifest ───────────────────
app.get("/configured/:config/manifest.json", (req, res) => {
    const { config } = req.params;
    console.log(`[MANIFEST] Configured manifest requested`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.json({
        id: "org.stremio.overseerr.configured",
        version: "1.0.0",
        name: "Overseerr Requests",
        description: "Request movies and shows through Overseerr",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"]
    });
});

// ─── Configured Stream Endpoint ───
app.get("/configured/:config/stream/:type/:id.json", async (req, res) => {
    const { config, type, id } = req.params;
    console.log(`[STREAM] Configured stream requested for ${type} ID: ${id}`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const userConfig = decodeConfig(config);
        if (!userConfig) {
            console.log(`[STREAM] Invalid configuration`);
            return res.json({ streams: [] });
        }

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

            if (tmdbResponse.ok) {
                const tmdbData = await tmdbResponse.json();
                const result = type === 'movie' ? tmdbData.movie_results?.[0] : tmdbData.tv_results?.[0];

                if (result) {
                    tmdbId = result.id;
                    title = result.title || result.name;
                    console.log(`[STREAM] Converted IMDb ${parsedId.imdbId} to TMDB ${tmdbId} - "${title}"`);
                } else {
                    console.log(`[STREAM] No TMDB result for IMDb: ${parsedId.imdbId}`);
                    return res.json({ streams: [] });
                }
            } else {
                console.log(`[STREAM] TMDB lookup failed for IMDb: ${parsedId.imdbId}`);
                return res.json({ streams: [] });
            }
        } else if (parsedId.tmdbId) {
            tmdbId = parsedId.tmdbId;
            
            // Get title from TMDB for better display
            const mediaType = type === 'movie' ? 'movie' : 'tv';
            const tmdbResponse = await fetch(
                `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${userConfig.tmdbKey}`
            );
            
            if (tmdbResponse.ok) {
                const tmdbData = await tmdbResponse.json();
                title = tmdbData.title || tmdbData.name || title;
            }
        }

        if (!tmdbId) {
            console.log(`[STREAM] No TMDB ID found`);
            return res.json({ streams: [] });
        }

        // Build streams array with longer video URL
        let streams = [];

        if (type === 'movie') {
            streams.push(createStreamObject(title, 'movie', tmdbId, null, null, config));
        } else if (type === 'series') {
            if (season !== null && episode !== null) {
                streams.push(createStreamObject(title, 'series', tmdbId, season, episode, config));
            } else {
                streams.push(createStreamObject(title, 'series', tmdbId, null, null, config));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: "${title}"`);

        // Do NOT trigger Overseerr here. The request will be triggered when the player
        // fetches the /test-video URL (on click/playback). This avoids making requests
        // when Stremio only lists or inspects streams.
        res.json({ streams: streams });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        res.json({ streams: [] });
    }
});

// ─── Default Manifest ───────────────
app.get("/manifest.json", (req, res) => {
    console.log(`[MANIFEST] Default manifest requested`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.json({
        id: "org.stremio.overseerr",
        version: "1.0.0",
        name: "Overseerr Requests",
        description: "Request movies and shows through Overseerr - configure your instance",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"]
    });
});

// ─── Default Stream Endpoint ───────
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
            streams.push(createStreamObject(title, 'movie', tmdbId));
        } else if (type === 'series') {
            if (parsedId.season !== null) {
                streams.push(createStreamObject(title, 'series', tmdbId, parsedId.season, parsedId.episode));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for default addon`);
        res.json({ streams: streams });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        res.json({ streams: [] });
    }
});

// ─── IMPROVED TEST VIDEO ENDPOINT WITH BETTER DEDUPLICATION ───
app.get("/test-video", async (req, res) => {
    console.log(`[TEST] Test video requested with Overseerr processing`);
    console.log('[TEST] query:', req.query);

    const { config, type, tmdbId, title, season, episode } = req.query;

    // ✅ FIXED: IMPROVED DEDUPLICATION LOGIC
    if (config && type && tmdbId && title) {
        const userConfig = decodeConfig(config);
        if (userConfig) {
            // Create a more stable dedupe key that persists across range requests
            const requestKey = `overseerr-${userConfig.overseerrUrl}-${userConfig.overseerrApi}-${type}-${tmdbId}-${season || ''}-${episode || ''}`;
            
            // Check if this is the initial request (not a range request)
            const isInitialRequest = !req.headers.range || req.headers.range.startsWith('bytes=0-');
            
            if (isInitialRequest && !pendingRequests.has(requestKey)) {
                console.log(`[OVERSEERR] 🔄 Starting NEW background request for: "${title}"`);
                
                // Set pending request with longer TTL
                const timeout = setTimeout(() => {
                    pendingRequests.delete(requestKey);
                    console.log(`[OVERSEERR] 🕒 TTL expired for: "${title}"`);
                }, REQUEST_TTL);
                
                pendingRequests.set(requestKey, {
                    timeout: timeout,
                    timestamp: Date.now(),
                    title: title
                });

                // Make the Overseerr request in background
                (async () => {
                    try {
                        const seasonNum = season ? parseInt(season) : null;
                        const reqType = type === 'movie' ? 'movie' : (seasonNum !== null ? 'season' : 'series');
                        
                        console.log(`[OVERSEERR] 🚀 Making API request for: "${title}"`);
                        const result = await makeOverseerrRequest(tmdbId, type, title, seasonNum, reqType, userConfig);
                        
                        if (result.success) {
                            console.log(`[OVERSEERR] ✅ SUCCESS: "${title}" - Request ID: ${result.requestId}`);
                        } else {
                            console.error(`[OVERSEERR] ❌ FAILED: "${title}" - ${result.error}`);
                        }
                    } catch (err) {
                        console.error(`[OVERSEERR] ❌ ERROR: "${title}" - ${err.message}`);
                    } finally {
                        // Keep the request in memory for TTL to prevent duplicates
                        // The timeout will automatically clean it up
                        console.log(`[OVERSEERR] 🏁 Completed processing for: "${title}"`);
                    }
                })();
            } else if (isInitialRequest) {
                const existingRequest = pendingRequests.get(requestKey);
                const age = Date.now() - existingRequest.timestamp;
                console.log(`[OVERSEERR] ⏩ SKIPPING: "${title}" - Already processing (${Math.floor(age/1000)}s ago)`);
            } else {
                console.log(`[OVERSEERR] 📦 RANGE REQUEST: "${title}" - Skipping duplicate check`);
            }
        } else {
            console.log('[TEST] Invalid user config in query string');
        }
    }

    // Proxy the wait video from the CDN and stream it to the client while preserving Range behavior.
    const waitUrl = "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Forward client's Range header if present
        const forwardHeaders = {};
        if (req.headers.range) forwardHeaders['Range'] = req.headers.range;
        // Some clients require a User-Agent; forward what's provided
        if (req.headers['user-agent']) forwardHeaders['User-Agent'] = req.headers['user-agent'];

        const upstreamResp = await fetch(waitUrl, { headers: forwardHeaders });

        // Copy relevant headers back to the client
        const headerNames = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified'];
        headerNames.forEach(h => {
            const v = upstreamResp.headers.get(h);
            if (v) res.setHeader(h, v);
        });

        // Use the exact upstream status (200 or 206)
        res.status(upstreamResp.status);

        // Pipe the upstream response body to the client
        const upstreamBody = upstreamResp.body;
        if (upstreamBody && typeof upstreamBody.pipe === 'function') {
            upstreamBody.pipe(res);
        } else {
            // Fallback: read as buffer then send
            const buffer = await upstreamResp.buffer();
            res.send(buffer);
        }
    } catch (err) {
        console.error('[TEST] Proxy error:', err.message);
        // If proxy fails, fallback to a redirect so the client still receives a playable location
        try {
            res.status(302).redirect(waitUrl);
        } catch (redirErr) {
            console.error('[TEST] Redirect fallback failed:', redirErr.message);
            res.status(502).send('Bad Gateway');
        }
    }
});

// ─── Health Check with Pending Requests Info ───
app.get("/health", (req, res) => {
    const pendingCount = pendingRequests.size;
    const pendingList = Array.from(pendingRequests.entries()).map(([key, value]) => ({
        key: key.substring(0, 50) + '...',
        title: value.title,
        age: Math.floor((Date.now() - value.timestamp) / 1000) + 's'
    }));

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'Ready',
        video: 'Using longer sample video (Big Buck Bunny)',
        pending_requests: pendingCount,
        pending_list: pendingList,
        behavior: 'Improved deduplication - prevents multiple requests ✅'
    });
});

// ─── Cleanup Endpoint (Optional) ───
app.get("/cleanup", (req, res) => {
    const beforeCount = pendingRequests.size;
    
    // Clean up expired requests
    const now = Date.now();
    for (const [key, value] of pendingRequests.entries()) {
        if (now - value.timestamp > REQUEST_TTL) {
            clearTimeout(value.timeout);
            pendingRequests.delete(key);
        }
    }
    
    const afterCount = pendingRequests.size;
    const cleaned = beforeCount - afterCount;
    
    res.json({
        cleaned: cleaned,
        remaining: afterCount,
        message: `Cleaned ${cleaned} expired requests, ${afterCount} remaining`
    });
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
            // Normalize the URL - remove trailing slashes
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

// Handle CORS preflight requests
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Api-Key');
    res.sendStatus(200);
});

// ─── COMPLETE CONFIGURATION PAGE WITH TESTING ────────────────────
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Stremio Overseerr Addon</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #fff; line-height: 1.6; padding: 20px; max-width: 800px; margin: 0 auto; }
            .container { background: #1a1a1a; border-radius: 12px; padding: 30px; margin: 20px 0; border: 1px solid #333; }
            h1 { color: #8ef; margin-bottom: 10px; }
            h2 { color: #9f9; margin: 25px 0 15px 0; border-bottom: 1px solid #333; padding-bottom: 8px; }
            h3 { color: #8ef; margin: 20px 0 10px 0; }
            .form-group { margin-bottom: 20px; }
            label { display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; }
            input, textarea { width: 100%; padding: 12px; background: #2a2a2a; border: 1px solid #444; border-radius: 6px; color: #fff; font-size: 14px; }
            input:focus, textarea:focus { outline: none; border-color: #8ef; }
            .btn { background: #28a745; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: 600; margin-right: 10px; margin-bottom: 10px; }
            .btn:hover { background: #34d058; }
            .btn:disabled { background: #6c757d; cursor: not-allowed; }
            .btn-test { background: #17a2b8; }
            .btn-test:hover { background: #138496; }
            .help-text { color: #888; font-size: 12px; margin-top: 5px; }
            .success { background: #155724; color: #d4edda; padding: 12px; border-radius: 6px; margin: 15px 0; }
            .error { background: #721c24; color: #f8d7da; padding: 12px; border-radius: 6px; margin: 15px 0; }
            .warning { background: #856404; color: #fff3cd; padding: 12px; border-radius: 6px; margin: 15px 0; }
            .addon-url { background: #2a2a2a; padding: 15px; border-radius: 6px; margin: 15px 0; font-family: monospace; word-break: break-all; }
            .links { margin-top: 25px; padding-top: 20px; border-top: 1px solid #333; }
            .links a { color: #8ef; text-decoration: none; margin-right: 15px; display: inline-block; margin-bottom: 8px; }
            .links a:hover { text-decoration: underline; }
            .test-section { background: #2a2a2a; padding: 15px; border-radius: 6px; margin: 15px 0; }
            .test-result { margin: 10px 0; padding: 10px; border-radius: 4px; }
            .test-success { background: #155724; color: #d4edda; }
            .test-error { background: #721c24; color: #f8d7da; }
            .loading { color: #17a2b8; }
            .video-tests { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 15px 0; }
            .video-test-item { background: #2a2a2a; padding: 15px; border-radius: 6px; text-align: center; }
            @media (max-width: 600px) {
                .video-tests { grid-template-columns: 1fr; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎬 Stremio Overseerr Addon</h1>
            <p>Configure your personal addon instance below. Your settings are encoded in the addon URL - no data is stored on the server.</p>

            <div class="success">
                <strong>✅ DEDUPLICATION FIXED:</strong> Now prevents multiple requests for the same movie/show!
            </div>

            <form id="configForm">
                <h2>🔑 API Configuration</h2>

                <div class="form-group">
                    <label for="tmdbKey">TMDB API Key *</label>
                    <input type="text" id="tmdbKey" name="tmdbKey" required placeholder="Enter your TMDB API key">
                    <div class="help-text">Get your free API key from: https://www.themoviedb.org/settings/api</div>
                </div>

                <div class="form-group">
                    <label for="overseerrUrl">Overseerr URL *</label>
                    <input type="text" id="overseerrUrl" name="overseerrUrl" required placeholder="https://overseerr.example.com or http://192.168.1.100:5055">
                    <div class="help-text">Your Overseerr instance URL (supports both domains and IP addresses)</div>
                </div>

                <div class="form-group">
                    <label for="overseerrApi">Overseerr API Key *</label>
                    <input type="text" id="overseerrApi" name="overseerrApi" required placeholder="Enter your Overseerr API key">
                    <div class="help-text">Get from Overseerr: Settings → API Keys → Generate New API Key</div>
                </div>

                <button type="button" class="btn" onclick="generateAddon()">Generate Addon URL</button>
                <button type="button" class="btn btn-test" onclick="testConfiguration()">Test Configuration</button>
            </form>

            <div id="result" style="display: none;">
                <h2>📦 Your Addon URL</h2>
                <div class="addon-url" id="addonUrl"></div>
                <p>Copy this URL and install it in Stremio:</p>
                <ol>
                    <li>Open Stremio</li>
                    <li>Click the puzzle piece icon (Addons)</li>
                    <li>Click "Community Addons"</li>
                    <li>Paste the URL above and click "Install"</li>
                </ol>
                <button class="btn" onclick="installInStremio()">Install in Stremio</button>
                <button class="btn btn-test" onclick="copyToClipboard()">Copy URL</button>
            </div>

            <div class="test-section">
                <h3>🧪 Test Your Configuration</h3>
                <p>Test if your API keys and URLs are working correctly:</p>
                <button class="btn btn-test" onclick="testConfiguration()">Test Configuration</button>
                <div id="testResults" style="margin-top: 10px;"></div>
            </div>

            <h3>🎬 Video Playback Tests</h3>
            <p>Test if the video playback works in your browser (required for Stremio):</p>

            <div class="video-tests">
                <div class="video-test-item">
                    <h4>Direct Video Test</h4>
                    <p>Test basic video streaming</p>
                    <a href="/test-video" target="_blank" class="btn btn-test">Test Video Playback</a>
                </div>
                <div class="video-test-item">
                    <h4>Movie Request Test</h4>
                    <p>Test movie request flow</p>
                    <a href="/stream/movie/tt0133093.json" target="_blank" class="btn btn-test">Test Movie Stream</a>
                </div>
                <div class="video-test-item">
                    <h4>TV Show Test</h4>
                    <p>Test TV show request flow</p>
                    <a href="/stream/series/tt0944947:1:1.json" target="_blank" class="btn btn-test">Test TV Stream</a>
                </div>
                <div class="video-test-item">
                    <h4>Health Check</h4>
                    <p>Check server status</p>
                    <a href="/health" target="_blank" class="btn btn-test">Check Health</a>
                </div>
            </div>

            <div class="links">
                <h3>🔗 Quick Links</h3>
                <a href="/health">❤️ Health Check</a>
                <a href="/cleanup">🧹 Cleanup Pending Requests</a>
                <a href="/test-video">🎬 Test Video Playback</a>
                <a href="/stream/movie/tt0133093.json">🎬 Test Movie Stream (Matrix)</a>
                <a href="/stream/series/tt0944947:1:1.json">📺 Test TV Episode Stream (GoT S1E1)</a>
                <a href="/manifest.json">📋 Manifest File</a>
                <a href="https://github.com/ericvlog/stremio-overseerr-addon" target="_blank">📚 GitHub Repository</a>
            </div>
        </div>

        <script>
            async function testConfiguration() {
                const form = document.getElementById('configForm');
                const formData = new FormData(form);

                const config = {
                    tmdbKey: formData.get('tmdbKey'),
                    overseerrUrl: formData.get('overseerrUrl'),
                    overseerrApi: formData.get('overseerrApi')
                };

                if (!config.tmdbKey || !config.overseerrUrl || !config.overseerrApi) {
                    document.getElementById('testResults').innerHTML = '<div class="error">Please fill in all fields first</div>';
                    return;
                }

                document.getElementById('testResults').innerHTML = '<div class="loading">Testing configuration... (this may take a few seconds)</div>';

                const testButton = document.querySelector('.test-section .btn');
                testButton.disabled = true;
                testButton.textContent = 'Testing...';

                try {
                    const response = await fetch('/api/test-configuration', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(config)
                    });

                    const result = await response.json();

                    let html = '';
                    if (result.success) {
                        html += '<div class="success">✅ All tests passed! Your configuration is working correctly.</div>';
                    } else {
                        html += '<div class="error">❌ Some tests failed. Please check your configuration.</div>';
                    }

                    result.results.forEach(test => {
                        const icon = test.status === 'success' ? '✅' : '❌';
                        const className = test.status === 'success' ? 'test-success' : 'test-error';
                        html += '<div class="test-result ' + className + '">' + icon + ' <strong>' + test.service + ':</strong> ' + test.message + '</div>';
                    });

                    document.getElementById('testResults').innerHTML = html;

                } catch (error) {
                    document.getElementById('testResults').innerHTML = '<div class="error">❌ Test failed: ' + error.message + '</div>';
                } finally {
                    testButton.disabled = false;
                    testButton.textContent = 'Test Configuration';
                }
            }

            function generateAddon() {
                const form = document.getElementById('configForm');
                const formData = new FormData(form);

                const config = {
                    tmdbKey: formData.get('tmdbKey'),
                    overseerrUrl: formData.get('overseerrUrl'),
                    overseerrApi: formData.get('overseerrApi')
                };

                // Basic validation
                if (!config.tmdbKey || !config.overseerrUrl || !config.overseerrApi) {
                    alert('Please fill in all required fields');
                    return;
                }

                // Encode configuration to base64
                const configJson = JSON.stringify(config);
                const configBase64 = btoa(configJson);

                // Generate addon URL
                const addonUrl = window.location.origin + '/configured/' + configBase64 + '/manifest.json';

                // Display result
                document.getElementById('addonUrl').textContent = addonUrl;
                document.getElementById('result').style.display = 'block';

                // Store for installation
                window.generatedAddonUrl = addonUrl;
            }

            function installInStremio() {
                if (window.generatedAddonUrl) {
                    // Use stremio protocol to install directly
                    const stremioUrl = 'stremio://' + window.generatedAddonUrl.replace(/^https?:\\/\\//, '');
                    window.location.href = stremioUrl;
                }
            }

            function copyToClipboard() {
                if (window.generatedAddonUrl) {
                    navigator.clipboard.writeText(window.generatedAddonUrl).then(function() {
                        alert('Addon URL copied to clipboard!');
                    }, function(err) {
                        console.error('Could not copy text: ', err);
                    });
                }
            }

            // Auto-focus first input
            document.addEventListener('DOMContentLoaded', function() {
                document.getElementById('tmdbKey').focus();
            });
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

// ─── Start Server ───────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Stremio Overseerr Addon running at: ${SERVER_URL}`);
    console.log(`🎬 Configuration page: ${SERVER_URL}/`);
    console.log(`📋 Default addon: ${SERVER_URL}/manifest.json`);
    console.log(`📋 User-specific addons: ${SERVER_URL}/configured/{config}/manifest.json`);
    console.log(`🎬 Test video: ${SERVER_URL}/test-video`);
    console.log(`🎬 Test movie stream: ${SERVER_URL}/stream/movie/tt0133093.json`);
    console.log(`📺 Test TV stream: ${SERVER_URL}/stream/series/tt0944947:1:1.json`);
    console.log(`🧪 Configuration testing: ${SERVER_URL}/api/test-configuration`);
    console.log(`❤️  Health: ${SERVER_URL}/health`);
    console.log(`🧹 Cleanup: ${SERVER_URL}/cleanup`);
    console.log(`🎯 Using longer sample video (Big Buck Bunny)`);
    console.log(`🚀 DEDUPLICATION FIXED: Prevents multiple requests for same content`);
});
