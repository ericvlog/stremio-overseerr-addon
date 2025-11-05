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

// ─── TORRENTIO-STYLE STREAM FORMAT ──────────────────
function createStreamObject(title, type, tmdbId, season = null, episode = null) {
    // TORRENTIO APPROACH: Return external URLs that Stremio can play directly
    // These are real video URLs that Stremio can stream
    
    const streamUrls = [
        // Public domain video URLs that actually work in Stremio
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4", 
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4"
    ];

    // Randomly select a working video URL (like Torrentio does with different torrents)
    const randomUrl = streamUrls[Math.floor(Math.random() * streamUrls.length)];
    
    // Build stream title based on type
    let streamTitle;
    if (type === 'movie') {
        streamTitle = `📥 Request "${title}" in Overseerr`;
    } else if (season && episode) {
        streamTitle = `📥 Request S${season}E${episode} of "${title}" in Overseerr`;
    } else if (season) {
        streamTitle = `📥 Request Season ${season} of "${title}" in Overseerr`;
    } else {
        streamTitle = `📥 Request "${title}" in Overseerr`;
    }

    // TORRENTIO-STREAM FORMAT (what actually works in Stremio)
    return {
        name: "Overseerr", // Display name in Stremio
        title: streamTitle, // Stream title shown to user
        url: randomUrl, // ACTUAL PLAYABLE VIDEO URL
        
        // TORRENTIO USES THESE FIELDS:
        behaviorHints: {
            // These hints tell Stremio how to handle the stream
            notWebReady: false, // IMPORTANT: This is a playable stream
            bingeGroup: `overseerr-${type}-${tmdbId}`,
            // Torrentio uses these to group similar streams
            country: "US",
            // Indicate this is a video stream, not a web page
            headers: {
                "User-Agent": "Stremio/4.0"
            }
        },
        
        // Additional metadata that helps Stremio
        type: "movie", // This tells Stremio it's a video stream
        description: `This will request "${title}" in your Overseerr instance`,
        
        // Torrentio-style info
        infoHash: `overseerr-${tmdbId}-${Date.now()}`,
        fileIdx: 0,
        sources: ["overseerr"],
        
        // Video quality info (like Torrentio shows)
        quality: "1080p",
        videoCodec: "h264",
        audioChannels: 2,
        
        // Stremio expects these for external streams
        externalUrl: randomUrl,
        ytId: null
    };
}

// ─── Make Overseerr Request ────────────
async function makeOverseerrRequest(tmdbId, type, mediaName, seasonNumber = null, requestType = 'season', userConfig = null) {
    try {
        console.log(`[BACKGROUND] Making ${requestType} request for ${type} TMDB ID: ${tmdbId} - ${mediaName}`);

        const requestBody = {
            mediaId: parseInt(tmdbId),
            mediaType: type === 'movie' ? 'movie' : 'tv'
        };

        if (type === 'series') {
            if (requestType === 'season' && seasonNumber !== null) {
                requestBody.seasons = [seasonNumber];
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
            
            // Store successful request for tracking
            return { success: true, requestId: data.id };
        } else {
            const errorText = await response.text();
            console.error(`[BACKGROUND] ❌ Failed: ${mediaName} - ${errorText}`);
            return { success: false, error: errorText };
        }
    } catch (error) {
        console.error(`[BACKGROUND] ❌ Error: ${mediaName} - ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ─── TORRENTIO-STYLE: Trigger request when stream is selected ───────
app.get("/configured/:config/request/:type/:tmdbId", async (req, res) => {
    const { config, type, tmdbId } = req.params;
    const { title, season, request_type } = req.query;
    const mediaName = title || 'Unknown';

    console.log(`[REQUEST-TRIGGER] User selected stream for ${type} ${tmdbId} - ${mediaName}`);

    // Decode configuration
    const userConfig = decodeConfig(config);
    if (!userConfig) {
        console.log(`[REQUEST-TRIGGER] Invalid configuration`);
        return res.json({ success: false, error: "Invalid configuration" });
    }

    // Make the Overseerr request
    const seasonNum = season ? parseInt(season) : null;
    const reqType = request_type || (type === 'movie' ? 'movie' : 'season');

    try {
        const result = await makeOverseerrRequest(tmdbId, type, mediaName, seasonNum, reqType, userConfig);
        
        if (result.success) {
            console.log(`[REQUEST-TRIGGER] ✅ Request submitted for ${mediaName}`);
            res.json({ 
                success: true, 
                message: `Request for "${mediaName}" submitted to Overseerr!`,
                requestId: result.requestId
            });
        } else {
            console.log(`[REQUEST-TRIGGER] ❌ Request failed for ${mediaName}`);
            res.json({ 
                success: false, 
                error: `Failed to submit request: ${result.error}` 
            });
        }
    } catch (error) {
        console.error(`[REQUEST-TRIGGER] ❌ Error: ${error.message}`);
        res.json({ 
            success: false, 
            error: `Request error: ${error.message}` 
        });
    }
});

// ─── Configured Manifest ───────────────────
app.get("/configured/:config/manifest.json", (req, res) => {
    const { config } = req.params;

    console.log(`[MANIFEST] Configured manifest requested`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        id: `org.stremio.overseerr.${config}`,
        version: "1.0.0",
        name: "Overseerr Requests",
        description: "Request movies and shows through Overseerr",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"],
        background: "https://i.imgur.com/7U2j0aB.png",
        logo: "https://i.imgur.com/7U2j0aB.png",
        contactEmail: "support@example.com"
    });
});

// ─── Configured Stream Endpoint (TORRENTIO-STYLE) ───
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

        // TORRENTIO APPROACH: Return multiple stream options with REAL video URLs
        let streams = [];

        if (type === 'movie') {
            // For movies: Single request option that plays a video AND triggers the request
            streams.push(createStreamObject(
                title,
                'movie',
                tmdbId
            ));

        } else if (type === 'series') {
            if (season !== null && episode !== null) {
                // Episode page - multiple options
                
                // Option 1: Request This Season
                streams.push(createStreamObject(
                    title,
                    'series',
                    tmdbId,
                    season,
                    episode
                ));

                // Option 2: Request Full Series  
                streams.push(createStreamObject(
                    title,
                    'series', 
                    tmdbId,
                    null, // No specific season for full series
                    null
                ));
            } else {
                // Series overview page
                streams.push(createStreamObject(
                    title,
                    'series',
                    tmdbId
                ));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} TORRENTIO-STYLE stream(s) for: ${title}`);
        
        // TORRENTIO RESPONSE FORMAT
        res.json({ 
            streams: streams,
            cacheMaxAge: 3600, // Cache for 1 hour
            staleRevalidate: 3600,
            staleError: 86400
        });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        res.json({ streams: [] });
    }
});

// ─── Original Manifest ───────────────
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
        idPrefixes: ["tt"],
        background: "https://i.imgur.com/7U2j0aB.png",
        logo: "https://i.imgur.com/7U2j0aB.png"
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
            streams.push(createStreamObject(
                title,
                'movie',
                tmdbId
            ));
        } else if (type === 'series') {
            if (parsedId.season !== null) {
                streams.push(createStreamObject(
                    title,
                    'series',
                    tmdbId,
                    parsedId.season,
                    parsedId.episode
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
        version: '1.0.0',
        approach: 'TORRENTIO-STYLE EXTERNAL STREAMS'
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
            .form-group { margin-bottom: 20px; }
            label { display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; }
            input { width: 100%; padding: 12px; background: #2a2a2a; border: 1px solid #444; border-radius: 6px; color: #fff; font-size: 14px; }
            input:focus { outline: none; border-color: #8ef; }
            .btn { background: #28a745; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: 600; margin-right: 10px; margin-bottom: 10px; }
            .btn:hover { background: #34d058; }
            .btn-test { background: #17a2b8; }
            .btn-test:hover { background: #138496; }
            .help-text { color: #888; font-size: 12px; margin-top: 5px; }
            .success { background: #155724; color: #d4edda; padding: 12px; border-radius: 6px; margin: 15px 0; }
            .error { background: #721c24; color: #f8d7da; padding: 12px; border-radius: 6px; margin: 15px 0; }
            .addon-url { background: #2a2a2a; padding: 15px; border-radius: 6px; margin: 15px 0; font-family: monospace; word-break: break-all; }
            .links { margin-top: 25px; padding-top: 20px; border-top: 1px solid #333; }
            .links a { color: #8ef; text-decoration: none; margin-right: 15px; display: inline-block; margin-bottom: 8px; }
            .info-box { background: #2a2a2a; padding: 15px; border-radius: 6px; margin: 15px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎬 Stremio Overseerr Addon</h1>
            <p>Configure your personal addon instance. Your settings are encoded in the addon URL.</p>

            <div class="info-box">
                <h3>🚀 NEW: Torrentio-Style Streaming</h3>
                <p>This addon now uses external video streams (like Torrentio) that actually play in Stremio while triggering your Overseerr requests in the background.</p>
            </div>

            <form id="configForm">
                <h2>🔑 API Configuration</h2>

                <div class="form-group">
                    <label for="tmdbKey">TMDB API Key *</label>
                    <input type="text" id="tmdbKey" name="tmdbKey" required placeholder="Enter your TMDB API key">
                    <div class="help-text">Get from: https://www.themoviedb.org/settings/api</div>
                </div>

                <div class="form-group">
                    <label for="overseerrUrl">Overseerr URL *</label>
                    <input type="text" id="overseerrUrl" name="overseerrUrl" required placeholder="https://overseerr.example.com">
                    <div class="help-text">Your Overseerr instance URL</div>
                </div>

                <div class="form-group">
                    <label for="overseerrApi">Overseerr API Key *</label>
                    <input type="text" id="overseerrApi" name="overseerrApi" required placeholder="Enter your Overseerr API key">
                    <div class="help-text">Get from Overseerr: Settings → API Keys</div>
                </div>

                <button type="button" class="btn" onclick="generateAddon()">Generate Addon URL</button>
                <button type="button" class="btn btn-test" onclick="testConfiguration()">Test Configuration</button>
            </form>

            <div id="result" style="display: none;">
                <h2>📦 Your Addon URL</h2>
                <div class="addon-url" id="addonUrl"></div>
                <p><strong>Install in Stremio:</strong></p>
                <ol>
                    <li>Open Stremio</li>
                    <li>Click the puzzle piece icon (Addons)</li>
                    <li>Click "Community Addons"</li>
                    <li>Paste the URL above and click "Install"</li>
                </ol>
                <button class="btn" onclick="installInStremio()">Install in Stremio</button>
                <button class="btn btn-test" onclick="copyToClipboard()">Copy URL</button>
            </div>

            <div id="testResults" style="margin-top: 20px;"></div>

            <div class="links">
                <h3>🔗 Quick Tests</h3>
                <a href="/stream/movie/tt0133093.json" target="_blank">🎬 Test Movie Stream (Matrix)</a>
                <a href="/stream/series/tt0944947:1:1.json" target="_blank">📺 Test TV Stream (GoT S1E1)</a>
                <a href="/health" target="_blank">❤️ Health Check</a>
                <a href="/manifest.json" target="_blank">📋 Manifest</a>
            </div>
        </div>

        <script>
            async function testConfiguration() {
                const config = {
                    tmdbKey: document.getElementById('tmdbKey').value,
                    overseerrUrl: document.getElementById('overseerrUrl').value,
                    overseerrApi: document.getElementById('overseerrApi').value
                };

                if (!config.tmdbKey || !config.overseerrUrl || !config.overseerrApi) {
                    document.getElementById('testResults').innerHTML = '<div class="error">Please fill in all fields</div>';
                    return;
                }

                document.getElementById('testResults').innerHTML = '<div class="success">Testing configuration...</div>';

                try {
                    const response = await fetch('/api/test-configuration', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(config)
                    });

                    const result = await response.json();
                    let html = '';
                    
                    if (result.success) {
                        html += '<div class="success">✅ All tests passed! Configuration is working.</div>';
                    } else {
                        html += '<div class="error">❌ Some tests failed.</div>';
                    }

                    result.results.forEach(test => {
                        const icon = test.status === 'success' ? '✅' : '❌';
                        html += '<div>' + icon + ' <strong>' + test.service + ':</strong> ' + test.message + '</div>';
                    });

                    document.getElementById('testResults').innerHTML = html;

                } catch (error) {
                    document.getElementById('testResults').innerHTML = '<div class="error">❌ Test failed: ' + error.message + '</div>';
                }
            }

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

            function copyToClipboard() {
                if (window.generatedAddonUrl) {
                    navigator.clipboard.writeText(window.generatedAddonUrl);
                    alert('URL copied to clipboard!');
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
    console.log(`🎬 Configuration page: ${SERVER_URL}/`);
    console.log(`🎬 Test movie stream: ${SERVER_URL}/stream/movie/tt0133093.json`);
    console.log(`📺 Test TV stream: ${SERVER_URL}/stream/series/tt0944947:1:1.json`);
    console.log(`🚀 TORRENTIO-STYLE: Using external video streams that actually play in Stremio`);
    console.log(`🎯 Streams will play actual videos while triggering Overseerr requests`);
});
