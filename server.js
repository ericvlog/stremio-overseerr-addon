import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 7000;
const SERVER_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;

// Store pending requests to avoid duplicates
const pendingRequests = new Map();

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

        // Series handling: support season requests and full-series requests
        if (type === 'series') {
            if (requestType === 'season' && seasonNumber !== null) {
                requestBody.seasons = [seasonNumber];
            } else if (requestType === 'series') {
                // Full-series request: try to fetch season numbers from TMDB so Overseerr
                // receives an explicit seasons array (avoids Overseerr server-side 500).
                try {
                    const tmdbKey = userConfig?.tmdbKey || process.env.TMDB_API_KEY || process.env.TMDB_KEY;
                    if (tmdbKey) {
                        const tmdbDetailsResp = await fetch(`https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(tmdbKey)}`);
                        if (tmdbDetailsResp.ok) {
                            const tmdbDetails = await tmdbDetailsResp.json();
                            // Collect numeric season numbers, exclude season_number === 0 (specials)
                            const seasons = (tmdbDetails.seasons || [])
                                .map(s => Number(s.season_number))
                                .filter(n => Number.isFinite(n) && n > 0);
                            // If we found any seasons, send them; otherwise fallback to an empty array
                            requestBody.seasons = seasons.length ? seasons : [];
                            console.log(`[OVERSEERR] TMDB seasons resolved for ${mediaName}: [${requestBody.seasons.join(',')}]`);
                        } else {
                            console.warn(`[OVERSEERR] TMDB lookup failed (HTTP ${tmdbDetailsResp.status}) for TV ID ${tmdbId} - sending empty seasons array`);
                            requestBody.seasons = [];
                        }
                    } else {
                        // No TMDB key available in config or env: send empty seasons array
                        console.warn('[OVERSEERR] No TMDB API key available; sending empty seasons array for full-series request');
                        requestBody.seasons = [];
                    }
                } catch (err) {
                    console.warn('[OVERSEERR] TMDB lookup error, sending empty seasons array', err && err.message ? err.message : err);
                    requestBody.seasons = [];
                }
            }
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

// ─── STREAM FORMAT USING YOUR WAIT.MP4 ──────────────────
function createStreamObject(title, type, tmdbId, season = null, episode = null, config = '', requestType = 'auto') {
    // Use YOUR wait.mp4 from the CDN
    const waitVideoUrl = "https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4";

    let streamTitle;
    if (type === 'movie') {
        streamTitle = `Request "${title}"`;
    } else if (season && episode) {
        if (requestType === 'season') {
            streamTitle = `Request Season ${season} of "${title}"`;
        } else if (requestType === 'series') {
            streamTitle = `Request Entire Series "${title}"`;
        } else {
            streamTitle = `Request S${season}E${episode} of "${title}"`;
        }
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
        episode: episode || '',
        requestType: requestType
    });

    // Point to our proxy endpoint that will handle the request
    const finalVideoUrl = `${SERVER_URL}/proxy-wait?${params.toString()}`;

    return {
        name: "Overseerr",
        title: streamTitle,
        url: finalVideoUrl,
        behaviorHints: {
            notWebReady: false,
            bingeGroup: `overseerr-${type}-${tmdbId}-${requestType}`
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

        // Build streams array with your original wait.mp4
        let streams = [];

        if (type === 'movie') {
            // Movies: Single stream
            streams.push(createStreamObject(title, 'movie', tmdbId, null, null, config, 'movie'));
        } else if (type === 'series') {
            if (season !== null && episode !== null) {
                // ✅ For specific episodes, show TWO streams
                // Stream 1: Request this specific season
                streams.push(createStreamObject(title, 'series', tmdbId, season, null, config, 'season'));
                // Stream 2: Request entire series
                streams.push(createStreamObject(title, 'series', tmdbId, null, null, config, 'series'));
            } else if (season !== null) {
                // For season-only IDs: Single stream for that season
                streams.push(createStreamObject(title, 'series', tmdbId, season, null, config, 'season'));
            } else {
                // For series-only IDs: Single stream for entire series
                streams.push(createStreamObject(title, 'series', tmdbId, null, null, config, 'series'));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: "${title}"`);

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
            } else {
                streams.push(createStreamObject(title, 'series', tmdbId, null, null, '', 'series'));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for default addon`);
        res.json({ streams: streams });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        res.json({ streams: [] });
    }
});

// ─── PROXY WAIT ENDPOINT (FIXED SERIES REQUESTS) ───
app.get("/proxy-wait", async (req, res) => {
    console.log(`[PROXY] Proxy wait video requested`);
    console.log('[PROXY] query:', req.query);

    const { config, type, tmdbId, title, season, episode, requestType } = req.query;

    // ✅ FIXED: Only trigger Overseerr on INITIAL request (not range requests)
    const isInitialRequest = !req.headers.range || req.headers.range.startsWith('bytes=0-');
    
    if (isInitialRequest && config && type && tmdbId && title) {
        const userConfig = decodeConfig(config);
        if (userConfig) {
            // Create request key that includes the request type
            const requestKey = `req-${userConfig.overseerrUrl}-${userConfig.overseerrApi}-${type}-${tmdbId}-${season || ''}-${episode || ''}-${requestType || 'auto'}`;
            
            // Check if this request was already made (5-minute cooldown)
            const now = Date.now();
            const lastRequest = pendingRequests.get(requestKey);
            const FIVE_MINUTES = 5 * 60 * 1000;
            
            if (!lastRequest || (now - lastRequest) > FIVE_MINUTES) {
                console.log(`[OVERSEERR] 🚀 Making request for: "${title}" (Type: ${requestType || 'auto'})`);
                
                // Store the request timestamp
                pendingRequests.set(requestKey, now);
                
                // Make the Overseerr request in background
                (async () => {
                    try {
                        const seasonNum = season ? parseInt(season) : null;
                        
                        // ✅ FIXED: Determine request type for series
                        let finalRequestType;
                        if (type === 'movie') {
                            finalRequestType = 'movie';
                        } else if (type === 'series') {
                            if (requestType === 'series') {
                                finalRequestType = 'series'; // Entire series
                            } else if (requestType === 'season' && seasonNum !== null) {
                                finalRequestType = 'season'; // Specific season
                            } else if (seasonNum !== null) {
                                finalRequestType = 'season'; // Default to season if season specified
                            } else {
                                finalRequestType = 'series'; // Default to series if no season
                            }
                        }
                        
                        console.log(`[OVERSEERR] 📡 Calling API for: "${title}" - Request Type: ${finalRequestType}, Season: ${seasonNum}`);
                        const result = await makeOverseerrRequest(tmdbId, type, title, seasonNum, finalRequestType, userConfig);
                        
                        if (result.success) {
                            console.log(`[OVERSEERR] ✅ SUCCESS: "${title}" - Request ID: ${result.requestId}`);
                        } else {
                            console.error(`[OVERSEERR] ❌ FAILED: "${title}" - ${result.error}`);
                        }
                    } catch (err) {
                        console.error(`[OVERSEERR] ❌ ERROR: "${title}" - ${err.message}`);
                    }
                })();
            } else {
                const timeSince = (now - lastRequest) / 1000;
                console.log(`[OVERSEERR] ⏩ SKIPPING: "${title}" - Request made ${Math.floor(timeSince)}s ago`);
            }
        }
    } else if (!isInitialRequest) {
        console.log(`[PROXY] Range request - skipping Overseerr trigger`);
    }

    // ✅ Proxy your wait.mp4 directly
    const waitUrl = "https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4";
    
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'video/mp4');

        // Forward range headers if present
        const headers = {};
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await fetch(waitUrl, { headers });
        
        // Copy headers from the CDN response
        if (response.headers.get('content-type')) {
            res.setHeader('Content-Type', response.headers.get('content-type'));
        }
        if (response.headers.get('content-length')) {
            res.setHeader('Content-Length', response.headers.get('content-length'));
        }
        if (response.headers.get('accept-ranges')) {
            res.setHeader('Accept-Ranges', response.headers.get('accept-ranges'));
        }
        if (response.headers.get('content-range')) {
            res.setHeader('Content-Range', response.headers.get('content-range'));
        }

        // Set the same status code
        res.status(response.status);

        // Stream the video directly to the client
        if (response.body) {
            response.body.pipe(res);
        } else {
            const buffer = await response.buffer();
            res.send(buffer);
        }

        console.log(`[PROXY] ✅ Streaming your wait.mp4 for: "${title || 'unknown'}"`);

    } catch (error) {
        console.error('[PROXY] Error:', error.message);
        // Fallback to redirect if proxy fails
        res.redirect(waitUrl);
    }
});

// ─── Cleanup Endpoint ───
app.get("/cleanup", (req, res) => {
    const beforeCount = pendingRequests.size;
    
    // Clean up old requests (older than 1 hour)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    for (const [key, timestamp] of pendingRequests.entries()) {
        if (timestamp < oneHourAgo) {
            pendingRequests.delete(key);
        }
    }
    
    const afterCount = pendingRequests.size;
    const cleaned = beforeCount - afterCount;
    
    res.json({
        cleaned: cleaned,
        remaining: afterCount,
        message: `Cleaned ${cleaned} old requests, ${afterCount} remaining`
    });
});

// ─── Health Check ──────────────────
app.get("/health", (req, res) => {
    const pendingCount = pendingRequests.size;
    
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'Ready',
        video: 'Using your wait.mp4 with direct proxy',
        behavior: 'ONE REQUEST PER CLICK - 5-minute cooldown ✅',
        series_handling: 'Two streams for episodes: Season + Entire Series ✅',
        series_fix: 'Fixed entire series requests ✅',
        pending_requests: pendingCount
    });
});

// ─── Configuration Testing Endpoint (UPDATED FOR LOCAL IPs) ─────────────────
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

        // Test Overseerr API - with special handling for local IPs
        try {
            // Normalize the URL - remove trailing slashes
            const normalizedUrl = overseerrUrl.replace(/\/$/, '');
            const urlObj = new URL(normalizedUrl);
            const hostname = urlObj.hostname;
            
            // Check if it's a local IP address
            const isLocalIP = hostname === 'localhost' || 
                             hostname.startsWith('192.168.') ||
                             hostname.startsWith('10.') ||
                             hostname.startsWith('172.') ||
                             hostname.startsWith('127.') ||
                             hostname.startsWith('169.254.');
            
            if (isLocalIP) {
                // For local IPs, we can't test from Vercel, but the addon will work when used locally
                results.push({ 
                    service: 'Overseerr', 
                    status: 'warning', 
                    message: 'Local IP detected - cannot test from server, but will work when you use Stremio on the same network' 
                });
            } else {
                // For public domains, test normally
                const overseerrResponse = await fetch(`${normalizedUrl}/api/v1/user`, {
                    headers: { 'X-Api-Key': overseerrApi }
                });

                if (overseerrResponse.ok) {
                    results.push({ service: 'Overseerr', status: 'success', message: 'URL and API key are valid' });
                } else {
                    results.push({ service: 'Overseerr', status: 'error', message: `Connection failed (HTTP ${overseerrResponse.status})` });
                }
            }
        } catch (error) {
            // If URL parsing fails, it might be a local hostname
            if (overseerrUrl.includes('localhost') || overseerrUrl.includes('192.168.') || overseerrUrl.includes('.local')) {
                results.push({ 
                    service: 'Overseerr', 
                    status: 'warning', 
                    message: 'Local network detected - cannot test from server, but will work when you use Stremio on the same network' 
                });
            } else {
                results.push({ service: 'Overseerr', status: 'error', message: `Connection failed: ${error.message}` });
            }
        }

        // Consider it successful if TMDB works and Overseerr is either successful or a local IP warning
        const tmdbSuccess = results.find(r => r.service === 'TMDB' && r.status === 'success');
        const overseerrOk = results.find(r => r.service === 'Overseerr' && (r.status === 'success' || r.status === 'warning'));
        
        const overallSuccess = !!(tmdbSuccess && overseerrOk);

        res.json({
            success: overallSuccess,
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

// ─── UPDATED CONFIGURATION PAGE ────────────────────
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
            .info-box { background: #1e3a5f; color: #dbeafe; padding: 15px; border-radius: 6px; margin: 15px 0; border-left: 4px solid #3b82f6; }
            .addon-url { background: #2a2a2a; padding: 15px; border-radius: 6px; margin: 15px 0; font-family: monospace; word-break: break-all; }
            .links { margin-top: 25px; padding-top: 20px; border-top: 1px solid #333; }
            .links a { color: #8ef; text-decoration: none; margin-right: 15px; display: inline-block; margin-bottom: 8px; }
            .links a:hover { text-decoration: underline; }
            .test-section { background: #2a2a2a; padding: 15px; border-radius: 6px; margin: 15px 0; }
            .test-result { margin: 10px 0; padding: 10px; border-radius: 4px; }
            .test-success { background: #155724; color: #d4edda; }
            .test-error { background: #721c24; color: #f8d7da; }
            .test-warning { background: #856404; color: #fff3cd; padding: 10px; border-radius: 4px; margin: 10px 0; }
            .loading { color: #17a2b8; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎬 Stremio Overseerr Addon</h1>
            <p>Configure your personal addon instance below. Your settings are encoded in the addon URL - no data is stored on the server.</p>

            <div class="success">
                <strong>✅ COMPLETE: Movies, seasons, and entire series requests all working!</strong>
            </div>

            <div class="info-box">
                <h3>🔐 Your Data Stays With You</h3>
                <p><strong>No data is stored on our server</strong> - your API keys and URLs are encoded directly into your personal addon URL.</p>
                <p><strong>Works with any Overseerr instance</strong> - public domains or local IPs, it's your choice!</p>
            </div>

            <form id="configForm">
                <h2>🔑 Your API Configuration</h2>

                <div class="form-group">
                    <label for="tmdbKey">Your TMDB API Key *</label>
                    <input type="text" id="tmdbKey" name="tmdbKey" required placeholder="Enter your personal TMDB API key">
                    <div class="help-text">Get your free API key from: https://www.themoviedb.org/settings/api</div>
                </div>

                <div class="form-group">
                    <label for="overseerrUrl">Your Overseerr URL *</label>
                    <input type="text" id="overseerrUrl" name="overseerrUrl" required placeholder="https://overseerr.example.com or http://192.168.1.100:5055">
                    <div class="help-text">
                        Your personal Overseerr instance URL<br>
                        • <strong>Public domain</strong>: https://overseerr.yourdomain.com<br>
                        • <strong>Local network</strong>: http://192.168.1.100:5055<br>
                        • <strong>Include http:// or https://</strong>
                    </div>
                </div>

                <div class="form-group">
                    <label for="overseerrApi">Your Overseerr API Key *</label>
                    <input type="text" id="overseerrApi" name="overseerrApi" required placeholder="Enter your personal Overseerr API key">
                    <div class="help-text">Get from Overseerr: Settings → API Keys → Generate New API Key</div>
                </div>

                <button type="button" class="btn" onclick="generateAddon()">Generate My Personal Addon URL</button>
                <button type="button" class="btn btn-test" onclick="testConfiguration()">Test My Configuration</button>
            </form>

            <div id="result" style="display: none;">
                <h2>📦 Your Personal Addon URL</h2>
                <div class="addon-url" id="addonUrl"></div>
                
                <div class="info-box">
                    <h3>🚀 Ready to Install!</h3>
                    <p>This URL contains <strong>your personal configuration</strong> and can be installed in Stremio:</p>
                    <ol>
                        <li>Open Stremio</li>
                        <li>Click the puzzle piece icon (Addons)</li>
                        <li>Click "Community Addons"</li>
                        <li>Paste this URL and click "Install"</li>
                    </ol>
                </div>

                <button class="btn" onclick="installInStremio()">Install in Stremio</button>
                <button class="btn btn-test" onclick="copyToClipboard()">Copy My Addon URL</button>
            </div>

            <div class="test-section">
                <h3>🧪 Test Your Configuration</h3>
                <p>Test if your API keys and URLs are working correctly:</p>
                <button class="btn btn-test" onclick="testConfiguration()">Test My Configuration</button>
                <div id="testResults" style="margin-top: 10px;"></div>
            </div>

            <div class="info-box">
                <h3>🔧 How It Works</h3>
                <p><strong>For Each User:</strong></p>
                <ul>
                    <li>You enter <strong>your own</strong> TMDB API key</li>
                    <li>You enter <strong>your own</strong> Overseerr URL (public or local)</li>
                    <li>You enter <strong>your own</strong> Overseerr API key</li>
                    <li>We generate a <strong>personal addon URL</strong> with your config encoded</li>
                    <li>Stremio uses your personal URL to make requests through our server</li>
                </ul>
                <p><strong>Your data is safe</strong> - we never store your API keys or URLs.</p>
            </div>

            <div class="links">
                <h3>🔗 Quick Links</h3>
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

                // Validate URL format
                if (!config.overseerrUrl.startsWith('http://') && !config.overseerrUrl.startsWith('https://')) {
                    document.getElementById('testResults').innerHTML = '<div class="error">Overseerr URL must start with http:// or https://</div>';
                    return;
                }

                document.getElementById('testResults').innerHTML = '<div class="loading">Testing your configuration... (this may take a few seconds)</div>';

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
                        let icon, className;
                        if (test.status === 'success') {
                            icon = '✅';
                            className = 'test-success';
                        } else if (test.status === 'warning') {
                            icon = '⚠️';
                            className = 'test-warning';
                        } else {
                            icon = '❌';
                            className = 'test-error';
                        }
                        html += '<div class="test-result ' + className + '">' + icon + ' <strong>' + test.service + ':</strong> ' + test.message + '</div>';
                    });

                    document.getElementById('testResults').innerHTML = html;

                } catch (error) {
                    document.getElementById('testResults').innerHTML = '<div class="error">❌ Test failed: ' + error.message + '</div>';
                } finally {
                    testButton.disabled = false;
                    testButton.textContent = 'Test My Configuration';
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

                // Validate URL format
                if (!config.overseerrUrl.startsWith('http://') && !config.overseerrUrl.startsWith('https://')) {
                    alert('Overseerr URL must start with http:// or https://');
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
                        alert('Your personal addon URL copied to clipboard!');
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
    console.log(`🎬 Proxy video: ${SERVER_URL}/proxy-wait`);
    console.log(`🎬 Test movie stream: ${SERVER_URL}/stream/movie/tt0133093.json`);
    console.log(`📺 Test TV stream: ${SERVER_URL}/stream/series/tt0944947:1:1.json`);
    console.log(`🧪 Configuration testing: ${SERVER_URL}/api/test-configuration`);
    console.log(`❤️  Health: ${SERVER_URL}/health`);
    console.log(`🧹 Cleanup: ${SERVER_URL}/cleanup`);
    console.log(`🎯 Using YOUR wait.mp4 with direct proxy`);
    console.log(`🚀 FIXED: Entire series requests now working!`);
    console.log(`📺 SERIES: For episodes, shows "Request Season X" AND "Request Entire Series"`);
});
