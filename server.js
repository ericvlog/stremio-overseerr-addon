import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import base64url from 'base64url';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration storage (in production, use a proper database)
let userConfigs = new Map();

// Routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Stremio Overseerr Addon</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            .form-group { margin-bottom: 15px; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
            button { background: #007cba; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
            button:hover { background: #005a87; }
        </style>
    </head>
    <body>
        <h1>Stremio Overseerr Addon</h1>
        <form id="configForm">
            <div class="form-group">
                <label for="tmdbKey">TMDB API Key:</label>
                <input type="text" id="tmdbKey" name="tmdbKey" required>
            </div>
            <div class="form-group">
                <label for="overseerrUrl">Overseerr URL:</label>
                <input type="url" id="overseerrUrl" name="overseerrUrl" required>
            </div>
            <div class="form-group">
                <label for="overseerrApi">Overseerr API Key:</label>
                <input type="text" id="overseerrApi" name="overseerrApi" required>
            </div>
            <button type="submit">Generate Addon URL</button>
        </form>
        <div id="result" style="margin-top: 20px; display: none;">
            <h3>Your Stremio Addon URL:</h3>
            <input type="text" id="addonUrl" readonly style="width: 100%; padding: 8px;">
            <p>Copy this URL and add it to Stremio as a community addon.</p>
        </div>
        <script>
            document.getElementById('configForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                
                const formData = {
                    tmdbKey: document.getElementById('tmdbKey').value,
                    overseerrUrl: document.getElementById('overseerrUrl').value,
                    overseerrApi: document.getElementById('overseerrApi').value
                };
                
                try {
                    const configString = JSON.stringify(formData);
                    const encodedConfig = btoa(unescape(encodeURIComponent(configString)));
                    const addonUrl = window.location.origin + '/configured/' + encodedConfig + '/manifest.json';
                    
                    document.getElementById('addonUrl').value = addonUrl;
                    document.getElementById('result').style.display = 'block';
                } catch (error) {
                    alert('Error generating URL: ' + error.message);
                }
            });
        </script>
    </body>
    </html>
  `);
});

// Test configuration endpoint
app.post('/api/test-configuration', async (req, res) => {
  try {
    const { overseerrUrl, overseerrApi } = req.body;
    
    console.log(`[TEST] Testing Overseerr with URL: ${overseerrUrl}`);
    
    const testUrl = `${overseerrUrl}/api/v1/auth/me`;
    const response = await fetch(testUrl, {
      headers: {
        'X-Api-Key': overseerrApi,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const userData = await response.json();
      res.json({ 
        success: true, 
        message: 'Successfully connected to Overseerr',
        user: userData 
      });
    } else {
      res.json({ 
        success: false, 
        message: `Failed to connect: ${response.status} ${response.statusText}` 
      });
    }
  } catch (error) {
    console.error('[TEST] Error testing configuration:', error);
    res.json({ 
      success: false, 
      message: `Connection error: ${error.message}` 
    });
  }
});

// Get config page
app.get('/config', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Configure Stremio Overseerr Addon</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        </style>
    </head>
    <body>
        <h1>Configuration</h1>
        <p>Redirecting to main page...</p>
        <script>
            window.location.href = '/';
        </script>
    </body>
    </html>
  `);
});

// Configured manifest endpoint
app.get('/configured/:config/manifest.json', (req, res) => {
  try {
    const configBase64 = req.params.config;
    console.log(`[MANIFEST] Configured manifest requested with config: ${configBase64.substring(0, 20)}...`);
    
    const manifest = {
      id: "community.overseerr",
      version: "1.0.0",
      name: "Overseerr",
      description: "Stream movies and shows from your Overseerr instance",
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: [],
      idPrefixes: ["tt"]
    };
    
    res.json(manifest);
  } catch (error) {
    console.error('[MANIFEST] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stream endpoint
app.get('/configured/:config/stream/:type/:id.json', async (req, res) => {
  try {
    const { config, type, id } = req.params;
    
    console.log(`[STREAM] Configured stream requested for ${type} ID: ${id}`);
    console.log(`[PARSER] Parsing ID: ${id} for type: ${type}`);
    
    // Decode configuration
    const configJson = JSON.parse(base64url.decode(config));
    const { tmdbKey, overseerrUrl, overseerrApi } = configJson;
    
    let tmdbId;
    
    // Handle IMDb to TMDB conversion
    if (id.startsWith('tt')) {
      console.log(`[STREAM] Converting IMDb ${id} to TMDB`);
      const imdbResponse = await fetch(
        `https://api.themoviedb.org/3/find/${id}?api_key=${tmdbKey}&external_source=imdb_id`
      );
      const imdbData = await imdbResponse.json();
      
      if (type === 'movie' && imdbData.movie_results && imdbData.movie_results.length > 0) {
        tmdbId = imdbData.movie_results[0].id;
        console.log(`[STREAM] Converted IMDb ${id} to TMDB ${tmdbId}`);
      } else if (type === 'series' && imdbData.tv_results && imdbData.tv_results.length > 0) {
        tmdbId = imdbData.tv_results[0].id;
        console.log(`[STREAM] Converted IMDb ${id} to TMDB ${tmdbId}`);
      }
    } else {
      tmdbId = id;
    }
    
    if (!tmdbId) {
      return res.json({ streams: [] });
    }
    
    // Create stream object
    const stream = {
      title: `Request on Overseerr`,
      url: `${overseerrUrl}/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`
    };
    
    console.log(`[STREAM] Returning 1 stream(s) for: ${id}`);
    
    res.json({
      streams: [stream]
    });
    
  } catch (error) {
    console.error('[STREAM] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Stremio Overseerr Addon running on port ${PORT}`);
});

export default app;
