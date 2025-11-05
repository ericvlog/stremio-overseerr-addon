import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 7000;
const SERVER_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;

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
            return { success: false, error: "Missing Overseerr configuration" };
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

// ─── SIMPLE STREAM FORMAT ──────────────────
function createStreamObject(title, type, tmdbId, season = null, episode = null) {
    // Use reliable public domain video URLs
    const streamUrls = [
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"
    ];

    const videoUrl = streamUrls[Math.floor(Math.random() * streamUrls.length)];
    
    let streamTitle;
    if (type === 'movie') {
        streamTitle = `Request "${title}"`;
    } else if (season && episode) {
        streamTitle = `Request S${season}E${episode}`;
    } else if (season) {
        streamTitle = `Request Season ${season}`;
    } else {
        streamTitle = `Request "${title}"`;
    }

    return {
        name: "Overseerr",
        title: streamTitle,
        url: videoUrl
    };
}

// ─── Configured Manifest ───────────────────
app.get("/configured/:config/manifest.json", (req, res) => {
    const { config } = req.params;
    console.log(`[MANIFEST] Configured manifest requested`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // SIMPLE MANIFEST - this is what Stremio expects
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
                    console.log(`[STREAM] Converted IMDb ${parsedId.imdbId} to TMDB ${tmdbId} - ${title}`);
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
        }

        if (!tmdbId) {
            console.log(`[STREAM] No TMDB ID found`);
            return res.json({ streams: [] });
        }

        // Build streams array
        let streams = [];

        if (type === 'movie') {
            streams.push(createStreamObject(title, 'movie', tmdbId));
        } else if (type === 'series') {
            if (season !== null && episode !== null) {
                streams.push(createStreamObject(title, 'series', tmdbId, season, episode));
            } else {
                streams.push(createStreamObject(title, 'series', tmdbId));
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: ${title}`);
        
        // AUTO-TRIGGER THE REQUEST
        const seasonNum = season ? parseInt(season) : null;
        const reqType = type === 'movie' ? 'movie' : 'season';
        
        console.log(`[BACKGROUND] Auto-triggering request for: ${title}`);
        makeOverseerrRequest(tmdbId, type, title, seasonNum, reqType, userConfig)
            .then(result => {
                if (result.success) {
                    console.log(`[BACKGROUND] ✅ Request successful for ${title}`);
                } else {
                    console.log(`[BACKGROUND] ❌ Request failed for ${title}: ${result.error}`);
                }
            })
            .catch(err => {
                console.error(`[BACKGROUND] ❌ Request error for ${title}: ${err.message}`);
            });
        
        res.json({ 
            streams: streams
        });

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

// ─── Health Check ──────────────────
app.get("/health", (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'Ready'
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
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f0f0f; color: #fff; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; }
            .card { background: #1a1a1a; padding: 20px; border-radius: 8px; margin: 20px 0; }
            input, button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 4px; border: 1px solid #333; }
            input { background: #2a2a2a; color: #fff; }
            button { background: #28a745; color: white; border: none; cursor: pointer; }
            button:hover { background: #34d058; }
            .addon-url { background: #2a2a2a; padding: 15px; border-radius: 4px; word-break: break-all; font-family: monospace; }
            .links a { color: #8ef; text-decoration: none; margin-right: 15px; }
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
                <p><strong>Install in Stremio:</strong></p>
                <ol>
                    <li>Open Stremio</li>
                    <li>Click the puzzle piece icon (Addons)</li>
                    <li>Click "Community Addons"</li>
                    <li>Paste the URL above and click "Install"</li>
                </ol>
                <button onclick="installInStremio()">Install in Stremio</button>
                <button onclick="copyToClipboard()" style="background: #17a2b8;">Copy URL</button>
            </div>

            <div class="card">
                <h3>🔗 Quick Tests</h3>
                <div class="links">
                    <a href="/manifest.json" target="_blank">Default Manifest</a>
                    <a href="/stream/movie/tt0133093.json" target="_blank">Test Movie Stream</a>
                    <a href="/stream/series/tt0944947:1:1.json" target="_blank">Test TV Stream</a>
                    <a href="/health" target="_blank">Health Check</a>
                </div>
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
                const configBase64 = btoa(configJson);
                
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
    console.log(`📋 Default addon: ${SERVER_URL}/manifest.json`);
    console.log(`🎬 Test movie: ${SERVER_URL}/stream/movie/tt0133093.json`);
    console.log(`📺 Test TV: ${SERVER_URL}/stream/series/tt0944947:1:1.json`);
    console.log(`🚀 Simple & Clean - Addon should appear in Stremio now`);
});
