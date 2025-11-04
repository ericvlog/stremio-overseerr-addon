import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}`
  : (process.env.SERVER_URL || `http://localhost:${PORT}`);

// Store request results
const requestResults = new Map();

// Improved video serving function
async function serveVideo(res, mediaName) {
    console.log(`[VIDEO] Serving video for ${mediaName}`);
    
    // Try local file first (for Docker/local)
    const localVideoPath = path.join(__dirname, "public", "wait.mp4");
    if (fs.existsSync(localVideoPath)) {
        console.log(`[VIDEO] Serving local video file`);
        
        const stat = fs.statSync(localVideoPath);
        const fileSize = stat.size;
        const range = res.req.headers.range;

        // Set proper video headers
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        // Handle range requests for video seeking
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            
            console.log(`[VIDEO] Range request: ${start}-${end}, chunk size: ${chunksize}`);
            
            const file = fs.createReadStream(localVideoPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunksize,
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            // Serve entire video
            const head = {
                'Content-Length': fileSize,
            };
            res.writeHead(200, head);
            fs.createReadStream(localVideoPath).pipe(res);
        }
        return true;
    }

    // Fallback: Use redirect (works everywhere)
    console.log(`[VIDEO] Local video not found, redirecting to GitHub`);
    res.redirect('https://github.com/ericvlog/stremio-overseerr-addon/raw/refs/heads/main/wait.mp4');
    return true;
}

// Function to properly decode Overseerr API key
function decodeOverseerrApi(encodedApiKey) {
    try {
        console.log(`[API KEY] Original: ${encodedApiKey.substring(0, 20)}...`);
        
        // If it's already a UUID format (with dashes), return as-is
        if (/^[a-fA-F0-9\-]{20,}$/.test(encodedApiKey)) {
            console.log(`[API KEY] Already valid UUID format`);
            return encodedApiKey;
        }
        
        // Try to decode as base64
        try {
            const buffer = Buffer.from(encodedApiKey, 'base64');
            const decoded = buffer.toString('utf8');
            
            // Check if decoded result looks like a valid API key
            if (decoded.length >= 20 && /^[a-zA-Z0-9\-_]+$/.test(decoded)) {
                console.log(`[API KEY] Successfully decoded from base64: ${decoded.substring(0, 20)}...`);
                return decoded;
            }
        } catch (e) {
            console.log(`[API KEY] Base64 decode failed, using original`);
        }
        
        return encodedApiKey;
    } catch (error) {
        console.error(`[API KEY] Error decoding: ${error.message}`);
        return encodedApiKey;
    }
}

// Improved Overseerr request with Vercel-specific fixes
async function makeConfiguredOverseerrRequest(tmdbId, type, mediaName, seasonNumber = null, episodeNumber = null, requestType = 'season', userConfig) {
    try {
        let requestDescription = mediaName;
        if (seasonNumber !== null && episodeNumber !== null) {
            if (requestType === 'season') {
                requestDescription = `${mediaName} Season ${seasonNumber}`;
            } else {
                requestDescription = `${mediaName} (Full Series)`;
            }
        }

        console.log(`[REQUEST] Making ${requestType} request for ${type} TMDB ID: ${tmdbId} - ${requestDescription}`);

        const requestBody = {
            mediaId: parseInt(tmdbId),
            mediaType: type === 'movie' ? 'movie' : 'tv'
        };

        if (type === 'series') {
            if (requestType === 'season' && seasonNumber !== null) {
                requestBody.seasons = [seasonNumber];
            } else if (requestType === 'series') {
                try {
                    const tmdbResponse = await fetch(
                        `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${userConfig.tmdbKey}`
                    );
                    
                    if (tmdbResponse.ok) {
                        const tvData = await tmdbResponse.json();
                        const allSeasons = tvData.seasons
                            .filter(season => season.season_number > 0)
                            .map(season => season.season_number);
                        
                        requestBody.seasons = allSeasons;
                    } else {
                        requestBody.seasons = [seasonNumber || 1];
                    }
                } catch (tmdbError) {
                    requestBody.seasons = [seasonNumber || 1];
                }
            }
        }

        // Validate and normalize Overseerr URL
        let overseerrUrl = userConfig.overseerrUrl;
        if (!overseerrUrl.startsWith('http')) {
            overseerrUrl = 'https://' + overseerrUrl;
        }
        overseerrUrl = overseerrUrl.replace(/\/$/, '');

        // Decode the API key properly
        const decodedApiKey = decodeOverseerrApi(userConfig.overseerrApi);

        console.log(`[REQUEST] Making request to: ${overseerrUrl}/api/v1/request`);
        console.log(`[REQUEST] Using API key: ${decodedApiKey.substring(0, 10)}...`);

        // Vercel-specific: Add proper headers and timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        try {
            const response = await fetch(
                `${overseerrUrl}/api/v1/request`,
                {
                    method: 'POST',
                    headers: {
                        'X-Api-Key': decodedApiKey,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Stremio-Overseerr-Addon/1.0.0'
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                }
            );

            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                console.log(`[REQUEST] Success for: ${requestDescription}`);
                return { success: true, data: data };
            } else {
                const errorText = await response.text();
                console.error(`[REQUEST] Failed: HTTP ${response.status} - ${errorText}`);
                
                let userError = `HTTP ${response.status}`;
                if (response.status === 401) {
                    userError = `Unauthorized (401) - Invalid API key`;
                } else if (response.status === 403) {
                    userError = `Forbidden (403) - API key rejected`;
                } else if (response.status === 404) {
                    userError = `Not Found (404) - Check Overseerr URL`;
                } else if (response.status >= 500) {
                    userError = `Overseerr Server Error (${response.status})`;
                }
                
                return {
                    success: false,
                    error: userError,
                    details: errorText
                };
            }
        } catch (fetchError) {
            clearTimeout(timeoutId);
            throw fetchError;
        }
    } catch (error) {
        console.error('[REQUEST] Failed:', error.message);
        
        let userFriendlyError = error.message;
        if (error.name === 'AbortError') {
            userFriendlyError = `Request timeout - Overseerr server took too long to respond`;
        } else if (error.code === 'EAI_AGAIN' || error.message.includes('getaddrinfo')) {
            userFriendlyError = `DNS resolution failed - cannot reach ${userConfig.overseerrUrl}`;
        } else if (error.message.includes('fetch failed')) {
            userFriendlyError = `Network error - cannot connect to Overseerr`;
        }
        
        return {
            success: false,
            error: userFriendlyError
        };
    }
}

// Parse Stremio ID formats
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

// Configuration Decoding for Torrentio-style URLs
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

function encodeConfig(config) {
    const configObj = {
        tmdbKey: config.tmdbKey,
        overseerrUrl: config.overseerrUrl,
        overseerrApi: config.overseerrApi,
        v: '1.0'
    };
    
    const configJson = JSON.stringify(configObj);
    return Buffer.from(configJson).toString('base64');
}

// Configured Manifest
app.get("/configured/:config/manifest.json", (req, res) => {
    const { config } = req.params;
    
    console.log(`[MANIFEST] Configured manifest requested with config: ${config.substring(0, 20)}...`);
    
    const userConfig = decodeConfig(config);
    if (!userConfig) {
        return res.status(400).json({ error: 'Invalid configuration' });
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        id: `org.overmio.addon.${config}`,
        version: "1.6.0",
        name: "OverMio Addon",
        description: "Request movies and shows in Overseerr",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"]
    });
});

// Configured Video Route
app.get("/configured/:config/video/:type/:tmdbId", async (req, res) => {
    const { config, type, tmdbId } = req.params;
    const { title, season, episode, request_type } = req.query;
    const mediaName = title || 'Unknown';

    console.log(`[VIDEO] Video requested for ${type} ${tmdbId} - ${mediaName}`);

    const userConfig = decodeConfig(config);
    if (!userConfig) {
        return res.status(400).send('Invalid configuration');
    }

    // Create unique request key
    let requestKey;
    if (type === 'movie') {
        requestKey = `movie-${tmdbId}-${config}`;
    } else {
        requestKey = request_type === 'series'
            ? `series-${tmdbId}-series-${config}`
            : `series-${tmdbId}-season-${season}-${config}`;
    }

    // Trigger Overseerr request in background
    if (!requestResults.has(requestKey)) {
        console.log(`[VIDEO] Making background request for ${mediaName}`);
        requestResults.set(requestKey, { processing: true });

        const seasonNum = season ? parseInt(season) : null;
        const episodeNum = episode ? parseInt(episode) : null;
        const reqType = request_type || (type === 'movie' ? 'movie' : 'season');

        makeConfiguredOverseerrRequest(tmdbId, type, mediaName, seasonNum, episodeNum, reqType, userConfig)
            .then(result => {
                console.log(`[BACKGROUND] Request completed for ${mediaName}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
                if (!result.success) {
                    console.log(`[BACKGROUND] Error: ${result.error}`);
                }
                requestResults.set(requestKey, result);
            })
            .catch(error => {
                console.error(`[BACKGROUND] Request error for ${mediaName}:`, error.message);
                requestResults.set(requestKey, { success: false, error: error.message });
            });
    }

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    
    // Serve video
    await serveVideo(res, mediaName);
});

// Configured Stream Endpoint
app.get("/configured/:config/stream/:type/:id.json", async (req, res) => {
    const { config, type, id } = req.params;

    console.log(`[STREAM] Configured stream requested for ${type} ID: ${id}`);

    const userConfig = decodeConfig(config);
    if (!userConfig) {
        return res.status(400).json({ error: 'Invalid configuration' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const parsedId = parseStremioId(id, type);
        if (!parsedId) {
            return res.json({ streams: [] });
        }

        let tmdbId;
        let title = `ID: ${id}`;
        let season = parsedId.season;
        let episode = parsedId.episode;

        if (parsedId.imdbId) {
            const tmdbResponse = await fetch(
                `https://api.themoviedb.org/3/find/${parsedId.imdbId}?api_key=${userConfig.tmdbKey}&external_source=imdb_id`
            );
            const tmdbData = await tmdbResponse.json();

            const result = type === 'movie' ? tmdbData.movie_results?.[0] : tmdbData.tv_results?.[0];
            if (result) {
                tmdbId = result.id;
                title = result.title || result.name;
                console.log(`[STREAM] Converted IMDb ${parsedId.imdbId} to TMDB ${tmdbId} - ${title}`);
            } else {
                return res.json({ streams: [] });
            }
        } else if (parsedId.tmdbId) {
            tmdbId = parsedId.tmdbId;
        }

        let streams = [];

        if (type === 'movie') {
            const videoUrl = `${SERVER_URL}/configured/${config}/video/movie/${tmdbId}?title=${encodeURIComponent(title)}`;
            streams.push({
                title: `Request Movie (Overseerr)`,
                url: videoUrl,
                name: "Overseerr",
                behaviorHints: {
                    notWebReady: false,
                    bingeGroup: `overseerr-${tmdbId}`
                }
            });
        } else if (type === 'series') {
            if (season !== null) {
                const seasonUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=season`;
                streams.push({
                    title: `Request Season ${season} (Overseerr)`,
                    url: seasonUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: false,
                        bingeGroup: `overseerr-${tmdbId}-season-${season}`
                    }
                });

                const seriesUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=series`;
                streams.push({
                    title: `Request Full Series (Overseerr)`,
                    url: seriesUrl,
                    name: "Overseerr", 
                    behaviorHints: {
                        notWebReady: false,
                        bingeGroup: `overseerr-${tmdbId}-series`
                    }
                });
            } else {
                const seriesUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&request_type=series`;
                streams.push({
                    title: `Request Series (Overseerr)`,
                    url: seriesUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: false,
                        bingeGroup: `overseerr-${tmdbId}-series`
                    }
                });
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: ${title}`);
        res.json({ streams });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        res.json({ streams: [] });
    }
});

// Configuration testing endpoint
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
            let normalizedUrl = overseerrUrl;
            if (!normalizedUrl.startsWith('http')) {
                normalizedUrl = 'https://' + normalizedUrl;
            }
            normalizedUrl = normalizedUrl.replace(/\/$/, '');
            
            const decodedApiKey = decodeOverseerrApi(overseerrApi);
            
            console.log(`[TEST] Testing Overseerr with URL: ${normalizedUrl}, API key: ${decodedApiKey.substring(0, 10)}...`);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const overseerrResponse = await fetch(`${normalizedUrl}/api/v1/user`, {
                headers: { 'X-Api-Key': decodedApiKey },
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            
            if (overseerrResponse.ok) {
                results.push({ service: 'Overseerr', status: 'success', message: 'URL and API key are valid' });
            } else if (overseerrResponse.status === 401) {
                results.push({ service: 'Overseerr', status: 'error', message: 'Unauthorized (401) - Invalid API key' });
            } else if (overseerrResponse.status === 403) {
                results.push({ service: 'Overseerr', status: 'error', message: 'Forbidden (403) - API key rejected' });
            } else {
                results.push({ service: 'Overseerr', status: 'error', message: `Connection failed (HTTP ${overseerrResponse.status})` });
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                results.push({ service: 'Overseerr', status: 'error', message: 'Connection timeout - Overseerr server not responding' });
            } else if (error.code === 'EAI_AGAIN' || error.message.includes('getaddrinfo')) {
                results.push({ service: 'Overseerr', status: 'error', message: 'DNS resolution failed - cannot reach the URL' });
            } else if (error.message.includes('fetch failed')) {
                results.push({ service: 'Overseerr', status: 'error', message: 'Network error - cannot connect to Overseerr' });
            } else {
                results.push({ service: 'Overseerr', status: 'error', message: `Connection failed: ${error.message}` });
            }
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

// Home page
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Stremio Overseerr Addon</title>
        <style>
            body { font-family: sans-serif; background: #111; color: #eee; padding: 30px; max-width: 800px; margin: 0 auto; }
            h1 { color: #8ef; }
            a { color: #9f9; }
            .container { background: #1a1a1a; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .btn { background: #28a745; color: white; padding: 10px 15px; border-radius: 5px; text-decoration: none; display: inline-block; margin: 5px; }
            .info { background: #0c5460; color: #d1ecf1; padding: 12px; border-radius: 6px; margin: 15px 0; }
        </style>
    </head>
    <body>
        <h1>🎬 Stremio Overseerr Addon</h1>
        <p>Server running: ${SERVER_URL}</p>
        
        <div class="info">
            <strong>✅ Auto-API Key Decoding:</strong> The system automatically handles base64 encoded API keys. Users can paste either format.
        </div>
        
        <div class="container">
            <h2>🔧 Configuration</h2>
            <p>Use the configuration page to generate your personal addon URL with your own API keys:</p>
            <a href="/config" class="btn">Open Configuration Page</a>
        </div>

        <div class="container">
            <h2>🎥 Video Test</h2>
            <p>Test if the video playback works (critical for Stremio):</p>
            <a href="/video-test" class="btn">Test Video Playback</a>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// Video test endpoint
app.get("/video-test", async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    
    console.log(`[VIDEO TEST] Video test requested`);
    await serveVideo(res, "Test Video");
});

// Configuration page
app.get("/config", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Configure Stremio Overseerr Addon</title>
        <style>
            body { font-family: sans-serif; background: #111; color: #eee; padding: 30px; max-width: 800px; margin: 0 auto; }
            .container { background: #1a1a1a; padding: 20px; border-radius: 8px; margin: 20px 0; }
            input { width: 100%; padding: 10px; margin: 5px 0; background: #2a2a2a; border: 1px solid #444; color: #fff; border-radius: 4px; }
            button { background: #28a745; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; margin: 5px; }
            .btn-test { background: #17a2b8; }
            .btn-install { background: #ff6b35; }
            .addon-url { background: #2a2a2a; padding: 15px; border-radius: 6px; margin: 15px 0; font-family: monospace; word-break: break-all; }
            .test-result { margin: 10px 0; padding: 10px; border-radius: 4px; }
            .test-success { background: #155724; color: #d4edda; }
            .test-error { background: #721c24; color: #f8d7da; }
            .info { background: #0c5460; color: #d1ecf1; padding: 12px; border-radius: 6px; margin: 15px 0; }
        </style>
    </head>
    <body>
        <h1>⚙️ Configure Stremio Overseerr Addon</h1>
        
        <div class="info">
            <strong>🔄 Auto-API Key Support:</strong> The system automatically handles base64 encoded API keys. Paste either format - it will work!
        </div>
        
        <div class="container">
            <form id="configForm">
                <h3>TMDB API Key *</h3>
                <input type="text" id="tmdbKey" placeholder="Your TMDB API Key" required>
                <small>Get from: https://www.themoviedb.org/settings/api</small>
                
                <h3>Overseerr URL *</h3>
                <input type="text" id="overseerrUrl" placeholder="https://overseerr.example.com" required>
                <small>Your Overseerr instance URL</small>
                
                <h3>Overseerr API Key *</h3>
                <input type="text" id="overseerrApi" placeholder="Your Overseerr API Key (any format)" required>
                <small>Get from Overseerr: Settings → API Keys → Generate New API Key</small>
                <small style="color: #8ef;">✅ Auto-decoding supported: Use raw key or base64 encoded</small>
                
                <button type="button" onclick="generateAddon()">Generate Addon URL</button>
                <button type="button" onclick="testConfiguration()" class="btn-test">Test Configuration</button>
            </form>
        </div>

        <div id="result" style="display: none;" class="container">
            <h3>📦 Your Addon URL</h3>
            <div class="addon-url" id="addonUrl"></div>
            
            <div style="margin: 15px 0;">
                <button onclick="installInStremio()" class="btn-install">🚀 Install in Stremio (Auto)</button>
                <p><small>This will automatically open Stremio and install the addon</small></p>
            </div>
            
            <p><strong>Manual Installation:</strong></p>
            <ol>
                <li>Open Stremio</li>
                <li>Click the puzzle piece icon (Addons)</li>
                <li>Click "Community Addons"</li>
                <li>Paste the URL above and click "Install"</li>
            </ol>
            
            <a href="/video-test" target="_blank" class="btn-test">Test Video Playback</a>
        </div>

        <div id="testResults" class="container"></div>

        <script>
            let currentAddonUrl = '';

            async function testConfiguration() {
                const config = {
                    tmdbKey: document.getElementById('tmdbKey').value,
                    overseerrUrl: document.getElementById('overseerrUrl').value,
                    overseerrApi: document.getElementById('overseerrApi').value
                };

                if (!config.tmdbKey || !config.overseerrUrl || !config.overseerrApi) {
                    document.getElementById('testResults').innerHTML = '<div class="test-error">Please fill in all fields</div>';
                    return;
                }

                document.getElementById('testResults').innerHTML = '<div class="test-result">Testing configuration...</div>';

                try {
                    const response = await fetch('/api/test-configuration', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(config)
                    });

                    const result = await response.json();
                    
                    let html = '';
                    if (result.success) {
                        html += '<div class="test-success">✅ All tests passed! Your configuration is working correctly.</div>';
                    } else {
                        html += '<div class="test-error">❌ Some tests failed. Please check your configuration.</div>';
                    }
                    
                    result.results.forEach(test => {
                        const className = test.status === 'success' ? 'test-success' : 'test-error';
                        html += '<div class="test-result ' + className + '">' + (test.status === 'success' ? '✅' : '❌') + ' <strong>' + test.service + ':</strong> ' + test.message + '</div>';
                    });
                    
                    document.getElementById('testResults').innerHTML = html;
                    
                } catch (error) {
                    document.getElementById('testResults').innerHTML = '<div class="test-error">Test failed: ' + error.message + '</div>';
                }
            }

            function generateAddon() {
                const config = {
                    tmdbKey: document.getElementById('tmdbKey').value,
                    overseerrUrl: document.getElementById('overseerrUrl').value,
                    overseerrApi: document.getElementById('overseerrApi').value
                };

                if (!config.tmdbKey || !config.overseerrUrl || !config.overseerrApi) {
                    alert('Please fill in all required fields');
                    return;
                }

                const configJson = JSON.stringify(config);
                const configBase64 = btoa(unescape(encodeURIComponent(configJson)));
                
                currentAddonUrl = window.location.origin + '/configured/' + configBase64 + '/manifest.json';
                
                document.getElementById('addonUrl').textContent = currentAddonUrl;
                document.getElementById('result').style.display = 'block';
                document.getElementById('result').scrollIntoView({ behavior: 'smooth' });
            }

            function installInStremio() {
                if (!currentAddonUrl) {
                    alert('Please generate an addon URL first');
                    return;
                }

                const stremioUrl = 'stremio://' + currentAddonUrl.replace(/^https?:\\/\\//, '');
                window.location.href = stremioUrl;
                
                setTimeout(() => {
                    if (!document.hidden) {
                        alert('Stremio not detected. Please make sure Stremio is installed and running, or manually copy the addon URL.');
                    }
                }, 1000);
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'Stremio Overseerr Addon',
        url: SERVER_URL,
        deployment: process.env.VERCEL ? 'Vercel' : 'Docker/Local'
    });
});

// Handle CORS
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.sendStatus(200);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Stremio Overseerr Addon running at: ${SERVER_URL}`);
    console.log(`🔧 Configuration page: ${SERVER_URL}/config`);
    console.log(`🎥 Video test: ${SERVER_URL}/video-test`);
    console.log(`❤️  Health check: ${SERVER_URL}/health`);
    console.log(`🚀 Deployment: ${process.env.VERCEL ? 'Vercel' : 'Docker/Local'}`);
    
    const localVideoPath = path.join(__dirname, "public", "wait.mp4");
    if (fs.existsSync(localVideoPath)) {
        const stats = fs.statSync(localVideoPath);
        console.log(`🎥 Local video found: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
    } else {
        console.log(`🎥 Local video not found, using GitHub redirect`);
    }
});

export default app;
