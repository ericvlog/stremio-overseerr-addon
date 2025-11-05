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
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OVERSEERR_URL = process.env.OVERSEERR_URL;
const OVERSEERR_API = process.env.OVERSEERR_API;

// Serve static files from public folder
app.use(express.static("public"));

// Store request results
const requestResults = new Map();

// Function to make Overseerr request
async function makeOverseerrRequest(tmdbId, type, mediaName, seasonNumber = null, episodeNumber = null, requestType = 'season') {
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

        // For TV shows, handle seasons based on request type
        if (type === 'series') {
            if (requestType === 'season' && seasonNumber !== null) {
                // Season request: request only the specific season
                requestBody.seasons = [seasonNumber];
                console.log(`[REQUEST] Setting seasons to [${seasonNumber}] for season request`);
            } else if (requestType === 'series') {
                // Full series request: get all available seasons from TMDB
                try {
                    console.log(`[REQUEST] Fetching available seasons for full series request...`);
                    const tmdbResponse = await fetch(
                        `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`
                    );

                    if (tmdbResponse.ok) {
                        const tvData = await tmdbResponse.json();
                        const allSeasons = tvData.seasons
                            .filter(season => season.season_number > 0) // Exclude season 0 (specials)
                            .map(season => season.season_number);

                        requestBody.seasons = allSeasons;
                        console.log(`[REQUEST] Setting seasons to all available: [${allSeasons.join(', ')}]`);
                    } else {
                        console.warn(`[REQUEST] Could not fetch seasons from TMDB, defaulting to season ${seasonNumber || 1}`);
                        requestBody.seasons = [seasonNumber || 1];
                    }
                } catch (tmdbError) {
                    console.warn(`[REQUEST] TMDB season fetch failed: ${tmdbError.message}, using default season`);
                    requestBody.seasons = [seasonNumber || 1];
                }
            }
        }

        console.log(`[REQUEST] Final request body:`, JSON.stringify(requestBody));

        const response = await fetch(
            `${OVERSEERR_URL}/api/v1/request`,
            {
                method: 'POST',
                headers: {
                    'X-Api-Key': OVERSEERR_API,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            }
        );

        if (response.ok) {
            const data = await response.json();
            console.log(`[REQUEST] Success for: ${requestDescription}`);
            return { success: true, data: data };
        } else {
            const errorText = await response.text();
            console.error('[REQUEST] Failed:', errorText);
            return {
                success: false,
                error: `HTTP ${response.status}: ${errorText}`
            };
        }
    } catch (error) {
        console.error('[REQUEST] Failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Function to check if local video exists
function getVideoPath() {
    const localVideoPath = path.join(__dirname, "public", "wait.mp4");
    if (fs.existsSync(localVideoPath)) {
        console.log(`[VIDEO] Local video found: ${localVideoPath}`);
        const stats = fs.statSync(localVideoPath);
        console.log(`[VIDEO] File size: ${stats.size} bytes, ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
        return localVideoPath;
    }
    console.log(`[VIDEO] Local video NOT found: ${localVideoPath}`);
    return null;
}

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
            // Episode format: "ttShowID:Season:Episode"
            const parts = id.split(':');
            if (parts.length === 3) {
                return {
                    imdbId: parts[0],
                    season: parseInt(parts[1]),
                    episode: parseInt(parts[2])
                };
            }
        } else if (id.startsWith('tt')) {
            // Series format: "tt1234567"
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

// ─── Configuration Decoding for Torrentio-style URLs ──────────────
function decodeConfig(configString) {
    try {
        // Simple base64 decoding of JSON configuration
        const configJson = Buffer.from(configString, 'base64').toString('utf8');
        const config = JSON.parse(configJson);

        // Validate required fields
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
    // Create configuration object
    const configObj = {
        tmdbKey: config.tmdbKey,
        overseerrUrl: config.overseerrUrl,
        overseerrApi: config.overseerrApi,
        v: '1.0' // configuration version
    };

    // Convert to base64
    const configJson = JSON.stringify(configObj);
    return Buffer.from(configJson).toString('base64');
}

// ─── NEW: Configured Manifest for User-specific URLs ───────────────────
app.get("/configured/:config/manifest.json", (req, res) => {
    const { config } = req.params;

    console.log(`[MANIFEST] Configured manifest requested with config: ${config.substring(0, 20)}...`);

    // Decode configuration
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

// ─── NEW: Configured Overseerr Request Function ────────────────────────
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

        // For TV shows, handle seasons based on request type
        if (type === 'series') {
            if (requestType === 'season' && seasonNumber !== null) {
                requestBody.seasons = [seasonNumber];
                console.log(`[REQUEST] Setting seasons to [${seasonNumber}] for season request`);
            } else if (requestType === 'series') {
                try {
                    console.log(`[REQUEST] Fetching available seasons for full series request...`);
                    const tmdbResponse = await fetch(
                        `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${userConfig.tmdbKey}`
                    );

                    if (tmdbResponse.ok) {
                        const tvData = await tmdbResponse.json();
                        const allSeasons = tvData.seasons
                            .filter(season => season.season_number > 0)
                            .map(season => season.season_number);

                        requestBody.seasons = allSeasons;
                        console.log(`[REQUEST] Setting seasons to all available: [${allSeasons.join(', ')}]`);
                    } else {
                        console.warn(`[REQUEST] Could not fetch seasons from TMDB, defaulting to season ${seasonNumber || 1}`);
                        requestBody.seasons = [seasonNumber || 1];
                    }
                } catch (tmdbError) {
                    console.warn(`[REQUEST] TMDB season fetch failed: ${tmdbError.message}, using default season`);
                    requestBody.seasons = [seasonNumber || 1];
                }
            }
        }

        console.log(`[REQUEST] Final request body:`, JSON.stringify(requestBody));

        const response = await fetch(
            `${userConfig.overseerrUrl}/api/v1/request`,
            {
                method: 'POST',
                headers: {
                    'X-Api-Key': userConfig.overseerrApi,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            }
        );

        if (response.ok) {
            const data = await response.json();
            console.log(`[REQUEST] Success for: ${requestDescription}`);
            return { success: true, data: data };
        } else {
            const errorText = await response.text();
            console.error('[REQUEST] Failed:', errorText);
            return {
                success: false,
                error: `HTTP ${response.status}: ${errorText}`
            };
        }
    } catch (error) {
        console.error('[REQUEST] Failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// ─── NEW: Configured Video Route (FIXED STREAMING) ───────
app.get("/configured/:config/video/:type/:tmdbId", async (req, res) => {
    const { config, type, tmdbId } = req.params;
    const { title, season, episode, request_type } = req.query;
    const mediaName = title || 'Unknown';

    console.log(`[VIDEO DEBUG] ========== VIDEO ENDPOINT CALLED ==========`);
    console.log(`[VIDEO DEBUG] Config: ${config.substring(0, 20)}...`);
    console.log(`[VIDEO DEBUG] Type: ${type}, TMDB ID: ${tmdbId}`);
    console.log(`[VIDEO DEBUG] Query params:`, { title, season, episode, request_type });
    console.log(`[VIDEO DEBUG] Headers:`, req.headers);
    console.log(`[VIDEO DEBUG] ===========================================`);

    // Decode configuration
    const userConfig = decodeConfig(config);
    if (!userConfig) {
        console.log(`[VIDEO DEBUG] Invalid configuration`);
        return res.status(400).send('Invalid configuration');
    }

    // Create unique request key based on request type AND media type AND user config
    let requestKey;
    if (type === 'movie') {
        // Movies don't have seasons - use simple key
        requestKey = `movie-${tmdbId}-${config}`;
    } else {
        // TV shows use season/series based keys
        requestKey = request_type === 'series'
            ? `series-${tmdbId}-series-${config}`
            : `series-${tmdbId}-season-${season}-${config}`;
    }

    console.log(`[VIDEO] Video requested for ${type} ${tmdbId} - ${mediaName}`,
        season ? `Season ${season}` : '',
        episode ? `Episode ${episode}` : '',
        request_type ? `Type: ${request_type}` : '',
        `Key: ${requestKey}`
    );

    // Trigger Overseerr request in background
    if (!requestResults.has(requestKey)) {
        console.log(`[VIDEO] Making background request for ${mediaName} (${request_type || (type === 'movie' ? 'movie' : 'season')})`);
        requestResults.set(requestKey, { processing: true });

        const seasonNum = season ? parseInt(season) : null;
        const episodeNum = episode ? parseInt(episode) : null;
        const reqType = request_type || (type === 'movie' ? 'movie' : 'season');

        makeConfiguredOverseerrRequest(tmdbId, type, mediaName, seasonNum, episodeNum, reqType, userConfig)
            .then(result => {
                console.log(`[BACKGROUND] ${reqType} request completed for ${mediaName}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
                if (result.success) {
                    console.log(`[BACKGROUND] Overseerr request ID: ${result.data.id}`);
                } else {
                    console.log(`[BACKGROUND] Error: ${result.error}`);
                }
                requestResults.set(requestKey, result);
            })
            .catch(error => {
                console.error(`[BACKGROUND] Request error for ${mediaName}:`, error.message);
                requestResults.set(requestKey, { success: false, error: error.message });
            });
    } else {
        console.log(`[VIDEO] Request already processed for ${requestKey}`);
    }

    // Set CORS headers for Stremio
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    // FIXED: Always redirect to CDN video for reliable streaming
    console.log(`[VIDEO] Redirecting to CDN video for ${mediaName}`);
    res.redirect('https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4');
});

// ─── NEW: Configured Stream Endpoint (SAME LOGIC, DIFFERENT CONFIG) ───
app.get("/configured/:config/stream/:type/:id.json", async (req, res) => {
    const { config, type, id } = req.params;

    console.log(`[STREAM] Configured stream requested for ${type} ID: ${id}`);

    // Decode configuration
    const userConfig = decodeConfig(config);
    if (!userConfig) {
        return res.status(400).json({ error: 'Invalid configuration' });
    }

    // Set CORS headers for Stremio
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        // Parse the Stremio ID format
        const parsedId = parseStremioId(id, type);
        if (!parsedId) {
            console.log(`[STREAM] Unsupported ID format, returning empty streams`);
            return res.json({ streams: [] });
        }

        let tmdbId;
        let title = `ID: ${id}`;
        let season = parsedId.season;
        let episode = parsedId.episode;

        // If we have an IMDb ID, convert to TMDB
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
                console.log(`[STREAM] TMDB lookup failed for IMDb: ${parsedId.imdbId}`);
                return res.json({ streams: [] });
            }
        } else if (parsedId.tmdbId) {
            // Already a TMDB ID
            tmdbId = parsedId.tmdbId;
        }

        // Build streams array - CRITICAL: Use proper Stremio stream format
        let streams = [];

        if (type === 'movie') {
            // For movies: just one option
            const videoUrl = `${SERVER_URL}/configured/${config}/video/movie/${tmdbId}?title=${encodeURIComponent(title)}`;
            streams.push({
                title: `Request Movie (Overseerr)`,
                url: videoUrl,
                // Stremio-specific properties that might help
                name: "Overseerr",
                behaviorHints: {
                    // These hints might help Stremio understand how to handle the stream
                    notWebReady: true,
                    bingeGroup: `overseerr-${tmdbId}`
                }
            });
        } else if (type === 'series') {
            if (season !== null) {
                // We're on an episode page - show TWO options

                // Option 1: Request This Season Only
                const seasonUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=season`;
                streams.push({
                    title: `Request Season ${season} (Overseerr)`,
                    url: seasonUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `overseerr-${tmdbId}-season-${season}`
                    }
                });

                // Option 2: Request Full Series
                const seriesUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=series`;
                streams.push({
                    title: `Request Full Series (Overseerr)`,
                    url: seriesUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `overseerr-${tmdbId}-series`
                    }
                });
            } else {
                // We're on series overview (though Stremio doesn't show addons here)
                const seriesUrl = `${SERVER_URL}/configured/${config}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&request_type=series`;
                streams.push({
                    title: `Request Series (Overseerr)`,
                    url: seriesUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `overseerr-${tmdbId}-series`
                    }
                });
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: ${title}`);
        streams.forEach((stream, index) => {
            console.log(`  ${index + 1}. ${stream.title}`);
            console.log(`     URL: ${stream.url}`);
        });

        res.json({ streams });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        // Return empty streams instead of erroring out
        res.json({ streams: [] });
    }
});

// ─── ORIGINAL: Manifest for Stremio ───────────────
app.get("/manifest.json", (req, res) => {
    console.log(`[MANIFEST] Manifest requested from ${req.ip}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        id: "org.overmio.addon",
        version: "1.6.0",
        name: "OverMio Addon",
        description: "Request movies and shows in Overseerr",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"]
    });
});

// ─── ORIGINAL: Video Route for Stremio (FIXED STREAMING) ────────────
app.get("/video/:type/:tmdbId", async (req, res) => {
    const { type, tmdbId } = req.params;
    const { title, season, episode, request_type } = req.query;
    const mediaName = title || 'Unknown';

    console.log(`[VIDEO DEBUG] ========== ORIGINAL VIDEO ENDPOINT CALLED ==========`);
    console.log(`[VIDEO DEBUG] Type: ${type}, TMDB ID: ${tmdbId}`);
    console.log(`[VIDEO DEBUG] Query params:`, { title, season, episode, request_type });
    console.log(`[VIDEO DEBUG] ====================================================`);

    // Create unique request key based on request type AND media type
    let requestKey;
    if (type === 'movie') {
        // Movies don't have seasons - use simple key
        requestKey = `movie-${tmdbId}`;
    } else {
        // TV shows use season/series based keys
        requestKey = request_type === 'series'
            ? `series-${tmdbId}-series`
            : `series-${tmdbId}-season-${season}`;
    }

    console.log(`[VIDEO] Video requested for ${type} ${tmdbId} - ${mediaName}`,
        season ? `Season ${season}` : '',
        episode ? `Episode ${episode}` : '',
        request_type ? `Type: ${request_type}` : '',
        `Key: ${requestKey}`
    );

    // Trigger Overseerr request in background
    if (!requestResults.has(requestKey)) {
        console.log(`[VIDEO] Making background request for ${mediaName} (${request_type || (type === 'movie' ? 'movie' : 'season')})`);
        requestResults.set(requestKey, { processing: true });

        const seasonNum = season ? parseInt(season) : null;
        const episodeNum = episode ? parseInt(episode) : null;
        const reqType = request_type || (type === 'movie' ? 'movie' : 'season');

        makeOverseerrRequest(tmdbId, type, mediaName, seasonNum, episodeNum, reqType)
            .then(result => {
                console.log(`[BACKGROUND] ${reqType} request completed for ${mediaName}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
                if (result.success) {
                    console.log(`[BACKGROUND] Overseerr request ID: ${result.data.id}`);
                } else {
                    console.log(`[BACKGROUND] Error: ${result.error}`);
                }
                requestResults.set(requestKey, result);
            })
            .catch(error => {
                console.error(`[BACKGROUND] Request error for ${mediaName}:`, error.message);
                requestResults.set(requestKey, { success: false, error: error.message });
            });
    } else {
        console.log(`[VIDEO] Request already processed for ${requestKey}`);
    }

    // Set CORS headers for Stremio
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    // FIXED: Always redirect to CDN video for reliable streaming
    console.log(`[VIDEO] Redirecting to CDN video for ${mediaName}`);
    res.redirect('https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4');
});

// ─── ORIGINAL: Stream Endpoint for Stremio ───────
app.get("/stream/:type/:id.json", async (req, res) => {
    const { type, id } = req.params;

    console.log(`[STREAM] Stream requested for ${type} ID: ${id}`);

    // Set CORS headers for Stremio
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        // Parse the Stremio ID format
        const parsedId = parseStremioId(id, type);
        if (!parsedId) {
            console.log(`[STREAM] Unsupported ID format, returning empty streams`);
            return res.json({ streams: [] });
        }

        let tmdbId;
        let title = `ID: ${id}`;
        let season = parsedId.season;
        let episode = parsedId.episode;

        // If we have an IMDb ID, convert to TMDB
        if (parsedId.imdbId) {
            const tmdbResponse = await fetch(
                `https://api.themoviedb.org/3/find/${parsedId.imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
            );
            const tmdbData = await tmdbResponse.json();

            const result = type === 'movie' ? tmdbData.movie_results?.[0] : tmdbData.tv_results?.[0];
            if (result) {
                tmdbId = result.id;
                title = result.title || result.name;
                console.log(`[STREAM] Converted IMDb ${parsedId.imdbId} to TMDB ${tmdbId} - ${title}`);
            } else {
                console.log(`[STREAM] TMDB lookup failed for IMDb: ${parsedId.imdbId}`);
                return res.json({ streams: [] });
            }
        } else if (parsedId.tmdbId) {
            // Already a TMDB ID
            tmdbId = parsedId.tmdbId;
        }

        // Build streams array
        let streams = [];

        if (type === 'movie') {
            // For movies: just one option
            const videoUrl = `${SERVER_URL}/video/movie/${tmdbId}?title=${encodeURIComponent(title)}`;
            streams.push({
                title: `Request Movie (Overseerr)`,
                url: videoUrl,
                name: "Overseerr",
                behaviorHints: {
                    notWebReady: true,
                    bingeGroup: `overseerr-${tmdbId}`
                }
            });
        } else if (type === 'series') {
            if (season !== null) {
                // We're on an episode page - show TWO options

                // Option 1: Request This Season Only
                const seasonUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=season`;
                streams.push({
                    title: `Request Season ${season} (Overseerr)`,
                    url: seasonUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `overseerr-${tmdbId}-season-${season}`
                    }
                });

                // Option 2: Request Full Series
                const seriesUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=series`;
                streams.push({
                    title: `Request Full Series (Overseerr)`,
                    url: seriesUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `overseerr-${tmdbId}-series`
                    }
                });
            } else {
                // We're on series overview (though Stremio doesn't show addons here)
                const seriesUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&request_type=series`;
                streams.push({
                    title: `Request Series (Overseerr)`,
                    url: seriesUrl,
                    name: "Overseerr",
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `overseerr-${tmdbId}-series`
                    }
                });
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: ${title}`);
        streams.forEach((stream, index) => {
            console.log(`  ${index + 1}. ${stream.title}`);
            console.log(`     URL: ${stream.url}`);
        });

        res.json({ streams });

    } catch (error) {
        console.error('[STREAM] Error:', error.message);
        // Return empty streams instead of erroring out
        res.json({ streams: [] });
    }
});

// Handle CORS preflight requests
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.sendStatus(200);
});

// ─── NEW: Server-side Configuration Testing Endpoints ─────────────────
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

// ─── CONFIGURATION PAGE (WITH VIDEO PLAYBACK TESTS) ────────────────────
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

            <form id="configForm">
                <h2>🔑 API Configuration</h2>

                <div class="form-group">
                    <label for="tmdbKey">TMDB API Key *</label>
                    <input type="text" id="tmdbKey" name="tmdbKey" required value="${TMDB_API_KEY || ''}">
                    <div class="help-text">Get your free API key from: https://www.themoviedb.org/settings/api</div>
                </div>

                <div class="form-group">
                    <label for="overseerrUrl">Overseerr URL *</label>
                    <input type="text" id="overseerrUrl" name="overseerrUrl" required value="${OVERSEERR_URL || ''}" placeholder="https://overseerr.example.com or http://192.168.1.100:5055">
                    <div class="help-text">Your Overseerr instance URL (supports both domains and IP addresses)</div>
                </div>

                <div class="form-group">
                    <label for="overseerrApi">Overseerr API Key *</label>
                    <input type="text" id="overseerrApi" name="overseerrApi" required value="${OVERSEERR_API || ''}">
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
            </div>

            <div class="test-section">
                <h3>🧪 Test Your Configuration</h3>
                <p>Test if your API keys and URLs are working correctly:</p>
                <button class="btn btn-test" onclick="testConfiguration()">Test Configuration</button>
                <div id="testResults" style="margin-top: 10px;"></div>
            </div>

            <h3>🎬 Critical Video Playback Tests</h3>
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
                    <a href="/video/movie/550?title=Test%20Movie" target="_blank" class="btn btn-test">Test Movie Request</a>
                </div>
                <div class="video-test-item">
                    <h4>Season Request Test</h4>
                    <p>Test TV season request</p>
                    <a href="/video/series/1399?title=Game%20of%20Thrones&season=1&request_type=season" target="_blank" class="btn btn-test">Test Season Request</a>
                </div>
                <div class="video-test-item">
                    <h4>Series Request Test</h4>
                    <p>Test full series request</p>
                    <a href="/video/series/1399?title=Game%20of%20Thrones&season=1&request_type=series" target="_blank" class="btn btn-test">Test Series Request</a>
                </div>
            </div>

            <div class="links">
                <h3>🔗 Quick Links</h3>
                <a href="/health">❤️ Health Check</a>
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
                const configBase64 = btoa(unescape(encodeURIComponent(configJson)));

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
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

// ─── ORIGINAL: Helper: Run self-tests ────────────
async function runSelfTests() {
    const results = [];

    // Local connection test
    results.push({
        name: "Local connection",
        status: "PASS",
        message: `Server running on ${SERVER_URL}`,
    });

    // Local video file test
    const localVideoPath = getVideoPath();
    if (localVideoPath) {
        const stats = fs.statSync(localVideoPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        results.push({
            name: "Local video file",
            status: "PASS",
            message: `wait.mp4 found (${fileSizeMB} MB)`,
        });
    } else {
        results.push({
            name: "Local video file",
            status: "WARNING",
            message: "wait.mp4 not found in public folder, using GitHub fallback",
        });
    }

    // TMDB API key
    if (TMDB_API_KEY) {
        results.push({
            name: "TMDB API key",
            status: "PASS",
            message: "Key loaded from .env",
        });
    } else {
        results.push({
            name: "TMDB API key",
            status: "FAIL",
            message: "Missing TMDB_API_KEY in .env",
        });
    }

    // Overseerr URL
    if (OVERSEERR_URL) {
        results.push({
            name: "Overseerr URL",
            status: "PASS",
            message: OVERSEERR_URL,
        });
    } else {
        results.push({
            name: "Overseerr URL",
            status: "FAIL",
            message: "Not defined",
        });
    }

    return results;
}

// ─── ORIGINAL: Status endpoints ──────────────────
app.get("/health", (req, res) => {
    const localVideoPath = getVideoPath();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        requestCount: requestResults.size,
        videoSource: localVideoPath ? 'local' : 'github'
    });
});

app.get("/status/:type/:tmdbId", (req, res) => {
    const { type, tmdbId } = req.params;
    const { season, request_type } = req.query;

    // Use the same key generation logic as video endpoint
    let requestKey;
    if (type === 'movie') {
        requestKey = `movie-${tmdbId}`;
    } else {
        requestKey = request_type
            ? `series-${tmdbId}-${request_type}`
            : season
                ? `series-${tmdbId}-season-${season}`
                : `series-${tmdbId}`;
    }

    if (requestResults.has(requestKey)) {
        res.json(requestResults.get(requestKey));
    } else {
        res.json({ status: 'not_found' });
    }
});

// ─── ORIGINAL: Direct video test endpoint ────────
app.get("/test-video", (req, res) => {
    const localVideoPath = getVideoPath();
    if (localVideoPath) {
        res.sendFile(localVideoPath);
    } else {
        res.redirect('https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4');
    }
});

// ─── Start Server ───────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Stremio Overseerr Addon running at: ${SERVER_URL}`);
    console.log(`🎬 Configuration page: ${SERVER_URL}/`);
    console.log(`📋 Standard addon: ${SERVER_URL}/manifest.json`);
    console.log(`📋 User-specific addons: ${SERVER_URL}/configured/{config}/manifest.json`);
    console.log(`🧪 Configuration testing: ${SERVER_URL}/api/test-configuration`);
    console.log(`❤️  Health: ${SERVER_URL}/health`);
    console.log(`🎬 Video tests: ${SERVER_URL}/test-video`);

    // Check for local video
    const localVideoPath = getVideoPath();
    if (localVideoPath) {
        const stats = fs.statSync(localVideoPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`🎥 Using local video: public/wait.mp4 (${fileSizeMB} MB)`);
    } else {
        console.log(`🎥 Using CDN video: https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4`);
    }

    // Run startup tests
    console.log("🧪 Running startup tests...");
    runSelfTests().then((results) => {
        results.forEach(test => {
            const icon = test.status === "PASS" ? "✅" : test.status === "WARNING" ? "⚠️" : "❌";
            console.log(`${icon} ${test.name}: ${test.message}`);
        });
        console.log("🚀 Addon is ready!");
        console.log("\n🎭 MULTI-STREAM SUPPORT:");
        console.log("   • Movies: Single 'Request Movie (Overseerr)' option");
        console.log("   • TV Episodes: TWO options:");
        console.log("     1. 'Request Season X (Overseerr)' - Requests only that season");
        console.log("     2. 'Request Full Series (Overseerr)' - Requests all seasons");
        console.log("\n🌐 TORRENTIO-STYLE URLS:");
        console.log("   • Users can generate personal addon URLs with their own API keys");
        console.log("   • Visit the configuration page to get started");
        console.log("\n🎬 CRITICAL VIDEO TESTS:");
        console.log("   • Direct video test: " + SERVER_URL + "/test-video");
        console.log("   • Movie request test: " + SERVER_URL + "/video/movie/550?title=Test%20Movie");
        console.log("   • TV request tests available on configuration page");
    });
});
