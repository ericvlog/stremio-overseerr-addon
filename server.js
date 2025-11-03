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
        return localVideoPath;
    }
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

// ─── Manifest for Stremio ───────────────────────
app.get("/manifest.json", (req, res) => {
    console.log(`[MANIFEST] Manifest requested from ${req.ip}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        id: "org.overmio.addon",
        version: "1.5.0",
        name: "OverMio Addon",
        description: "Request movies and shows in Overseerr",
        resources: ["stream"],
        types: ["movie", "series"],
        catalogs: [],
        idPrefixes: ["tt"]
    });
});

// ─── Video Route for Stremio ────────────────────
app.get("/video/:type/:tmdbId", async (req, res) => {
    const { type, tmdbId } = req.params;
    const { title, season, episode, request_type } = req.query;
    const mediaName = title || 'Unknown';

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
                requestResults.set(requestKey, result);
            })
            .catch(error => {
                console.error(`[BACKGROUND] Request error for ${mediaName}:`, error.message);
                requestResults.set(requestKey, { success: false, error: error.message });
            });
    } else {
        console.log(`[VIDEO] Request already processed for ${requestKey}`);
    }

    // Check if local video exists
    const localVideoPath = getVideoPath();

    // Set CORS headers for Stremio
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    if (localVideoPath) {
        console.log(`[VIDEO] Serving local video file for ${mediaName}`);

        // Get file stats
        const stat = fs.statSync(localVideoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        // Handle range requests for video seeking
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(localVideoPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            // Serve entire video
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            };
            res.writeHead(200, head);
            fs.createReadStream(localVideoPath).pipe(res);
        }
    } else {
        // Fallback to GitHub video
        console.log(`[VIDEO] Local video not found, redirecting to GitHub video for ${mediaName}`);
        res.redirect('https://github.com/ericvlog/stremio-overseerr-addon/raw/refs/heads/main/wait.mp4');
    }
});

// ─── Stream Endpoint for Stremio ────────────────
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
                url: videoUrl
            });
        } else if (type === 'series') {
            if (season !== null) {
                // We're on an episode page - show TWO options

                // Option 1: Request This Season Only
                const seasonUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=season`;
                streams.push({
                    title: `Request Season ${season} (Overseerr)`,
                    url: seasonUrl
                });

                // Option 2: Request Full Series
                const seriesUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&season=${season}&episode=${episode || 1}&request_type=series`;
                streams.push({
                    title: `Request Full Series (Overseerr)`,
                    url: seriesUrl
                });
            } else {
                // We're on series overview (though Stremio doesn't show addons here)
                const seriesUrl = `${SERVER_URL}/video/series/${tmdbId}?title=${encodeURIComponent(title)}&request_type=series`;
                streams.push({
                    title: `Request Series (Overseerr)`,
                    url: seriesUrl
                });
            }
        }

        console.log(`[STREAM] Returning ${streams.length} stream(s) for: ${title}`);
        streams.forEach((stream, index) => {
            console.log(`  ${index + 1}. ${stream.title}`);
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

// ─── Helper: Run self-tests ─────────────────────
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

// ─── Status endpoints ───────────────────────────
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

// Direct video test endpoint
app.get("/test-video", (req, res) => {
    const localVideoPath = getVideoPath();
    if (localVideoPath) {
        res.sendFile(localVideoPath);
    } else {
        res.redirect('https://github.com/ericvlog/stremio-overseerr-addon/raw/refs/heads/main/wait.mp4');
    }
});

// ─── Homepage with Live Test Results ────────────
app.get("/", async (req, res) => {
    const results = await runSelfTests();
    const allPassed = results.every((r) => r.status === "PASS" || r.status === "WARNING");

    const testHTML = results
        .map(
            (r) =>
                `<li> ${r.status === "PASS" ? "✅" : r.status === "WARNING" ? "⚠️" : "❌"} <b>${r.name}</b> – ${r.message}</li>`
        )
        .join("");

    const stremioInstall = `stremio://${SERVER_URL.replace(/^https?:\/\//, "")}/manifest.json`;

    res.send(`
    <html>
        <head>
            <title>Stremio Overseerr Addon</title>
            <style>
                body { font-family: sans-serif; background: #111; color: #eee; padding: 30px; }
                h1 { color: #8ef; }
                a { color: #9f9; }
                li { margin-bottom: 6px; }
                .install { display: inline-block; padding: 10px 15px; background: #28a745; color: white; border-radius: 8px; text-decoration: none; margin-top: 15px; }
                .install:hover { background: #34d058; }
            </style>
        </head>
        <body>
            <h1>🎬 Stremio Overseerr Addon</h1>
            <p>Server running at: ${SERVER_URL}</p>
            <h3>Test Results:</h3>
            <ul>${testHTML}</ul>
            <p>🎬 <a href="${SERVER_URL}/test-video" target="_blank">Test Video Playback</a></p>
            <p>🎬 <a href="${SERVER_URL}/video/movie/550?title=Test%20Movie" target="_blank">Test Movie Request</a></p>
            <p>📺 <a href="${SERVER_URL}/video/series/1399?title=Game%20of%20Thrones&season=1&request_type=season" target="_blank">Test Season Request</a></p>
            <p>📺 <a href="${SERVER_URL}/video/series/1399?title=Game%20of%20Thrones&season=1&request_type=series" target="_blank">Test Series Request</a></p>
            <p>📊 <a href="${SERVER_URL}/health" target="_blank">Health Check</a></p>
            <p>🎞️ <a href="${SERVER_URL}/stream/movie/tt0133093.json" target="_blank">Test Movie Stream (Matrix)</a></p>
            <p>📺 <a href="${SERVER_URL}/stream/series/tt0944947:1:1.json" target="_blank">Test TV Episode Stream (GoT S1E1)</a></p>
            <a class="install" href="${stremioInstall}">📦 Install Addon to Stremio</a>
            <p style="margin-top:30px;color:#aaa;">${allPassed ? "✅ All systems operational" : "⚠️ Some tests failed. Check .env and files."}</p>
        </body>
    </html>
    `);
});

// ─── Start Server ───────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running at: ${SERVER_URL}`);
    console.log(`📋 Manifest: ${SERVER_URL}/manifest.json`);
    console.log(`🎬 Stream endpoint: ${SERVER_URL}/stream/{type}/{id}.json`);
    console.log(`📺 Video endpoint: ${SERVER_URL}/video/{type}/{tmdbId}`);
    console.log(`❤️  Health: ${SERVER_URL}/health`);

    // Check for local video
    const localVideoPath = getVideoPath();
    if (localVideoPath) {
        const stats = fs.statSync(localVideoPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`🎥 Using local video: public/wait.mp4 (${fileSizeMB} MB)`);
    } else {
        console.log(`🎥 Using GitHub video: https://github.com/ericvlog/stremio-overseerr-addon/raw/refs/heads/main/wait.mp4`);
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
        console.log("   • Both options now working correctly!");
    });
});
