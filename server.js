const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = 'b9ec03e24520c344670f7a67d5e8c5f9';

// Simple logging
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    level,
    message,
    ...data
  }));
}

// Basic configuration parsing
function parseConfiguration(configBase64) {
  try {
    if (!configBase64) {
      throw new Error('No configuration provided');
    }
    
    // Simple base64 decoding
    const configJson = Buffer.from(configBase64, 'base64').toString('utf8');
    const config = JSON.parse(configJson);
    
    log('INFO', 'Configuration parsed', {
      overseerrUrl: config.overseerrUrl,
      hasApiKey: !!config.overseerrApi
    });
    
    return config;
  } catch (error) {
    log('ERROR', 'Configuration parsing failed', { error: error.message });
    throw error;
  }
}

// Convert IMDb to TMDB
async function convertImdbToTmdb(imdbId) {
  log('INFO', 'Converting IMDb to TMDB', { imdbId });
  
  const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`TMDB API returned ${response.status}`);
  }
  
  const data = await response.json();
  const tmdbId = data.movie_results?.[0]?.id;
  
  if (!tmdbId) {
    throw new Error(`No TMDB ID found for IMDb ${imdbId}`);
  }
  
  log('INFO', 'Conversion successful', { imdbId, tmdbId });
  return tmdbId;
}

// Check Overseerr availability
async function checkOverseerrAvailability(overseerrUrl, apiKey, tmdbId, title) {
  const startTime = Date.now();
  
  log('INFO', 'Checking Overseerr availability', {
    title,
    tmdbId,
    overseerrUrl
  });
  
  try {
    const apiUrl = `${overseerrUrl}/api/v1/request?take=10&filter=available`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`Overseerr API returned ${response.status}`);
    }
    
    const data = await response.json();
    const available = data.results?.some(req => req.media?.status === 3) || false;
    const duration = Date.now() - startTime;
    
    log('INFO', 'Availability check completed', {
      title,
      tmdbId,
      available,
      duration: `${duration}ms`
    });
    
    return { available, requests: data.results || [] };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    log('ERROR', 'Availability check failed', {
      title,
      tmdbId,
      error: error.message,
      duration: `${duration}ms`
    });
    throw error;
  }
}

// Test configuration
async function testConfiguration(overseerrUrl, apiKey) {
  const startTime = Date.now();
  
  log('INFO', 'Testing configuration', { overseerrUrl });
  
  try {
    const testUrl = `${overseerrUrl}/api/v1/user`;
    const response = await fetch(testUrl, {
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    
    const userData = await response.json();
    const duration = Date.now() - startTime;
    
    log('INFO', 'Configuration test passed', {
      user: userData.email,
      duration: `${duration}ms`
    });
    
    return { success: true, user: userData.email };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    log('ERROR', 'Configuration test failed', {
      error: error.message,
      duration: `${duration}ms`
    });
    return { success: false, error: error.message };
  }
}

// Stream handler
async function handleStreamRequest(id, type, config) {
  const startTime = Date.now();
  
  log('INFO', 'Stream request received', { id, type });
  
  try {
    // Convert IMDb to TMDB
    const tmdbId = await convertImdbToTmdb(id);
    
    // Get movie title (optional)
    const movieUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const movieResponse = await fetch(movieUrl);
    const movieData = await movieResponse.json();
    const title = movieData.title || 'Unknown';
    
    // Check availability
    const availability = await checkOverseerrAvailability(
      config.overseerrUrl,
      config.overseerrApi,
      tmdbId,
      title
    );
    
    // Prepare streams
    const streams = [];
    
    if (availability.available) {
      streams.push({
        url: `https://stremio-overseerr-addon.vercel.app/video-test`,
        title: `Watch ${title}`,
        name: 'Overseerr'
      });
    }
    
    // Always include test stream
    streams.push({
      url: `https://stremio-overseerr-addon.vercel.app/video-test`,
      title: `Test Stream for ${title}`,
      name: 'Test Stream'
    });
    
    const duration = Date.now() - startTime;
    log('INFO', 'Stream request completed', {
      id,
      title,
      streamCount: streams.length,
      duration: `${duration}ms`
    });
    
    return { streams };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    log('ERROR', 'Stream request failed', {
      id,
      error: error.message,
      duration: `${duration}ms`
    });
    
    // Return fallback stream
    return {
      streams: [{
        url: `https://stremio-overseerr-addon.vercel.app/video-test`,
        title: 'Test Stream (Fallback)',
        name: 'Test Stream'
      }]
    };
  }
}

// Routes

// Manifest
app.get('/manifest.json', (req, res) => {
  log('INFO', 'Manifest requested');
  res.json({
    id: "community.overseerr",
    version: "1.0.0",
    name: "Overseerr",
    description: "Browse and watch content from Overseerr",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: []
  });
});

// Configured manifest
app.get('/configured/:config/manifest.json', (req, res) => {
  const config = req.params.config;
  
  try {
    const configData = parseConfiguration(config);
    
    log('INFO', 'Configured manifest sent', {
      overseerrUrl: configData.overseerrUrl
    });
    
    res.json({
      id: "community.overseerr",
      version: "1.0.0",
      name: `Overseerr (${new URL(configData.overseerrUrl).hostname})`,
      description: `Overseerr integration`,
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: []
    });
    
  } catch (error) {
    log('ERROR', 'Configured manifest failed', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

// Stream endpoint
app.get('/configured/:config/stream/:type/:id.json', async (req, res) => {
  const { config, type, id } = req.params;
  
  try {
    const configData = parseConfiguration(config);
    const result = await handleStreamRequest(id, type, configData);
    res.json(result);
  } catch (error) {
    log('ERROR', 'Stream endpoint failed', { id, error: error.message });
    res.json({ streams: [] });
  }
});

// Configuration test
app.post('/api/test-configuration', async (req, res) => {
  const { overseerrUrl, apiKey } = req.body;
  
  log('INFO', 'Configuration test requested', { overseerrUrl });
  
  try {
    const result = await testConfiguration(overseerrUrl, apiKey);
    res.json(result);
  } catch (error) {
    log('ERROR', 'Configuration test endpoint failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Video test endpoint
app.get('/video-test', (req, res) => {
  log('INFO', 'Video test requested');
  
  // Simple response for testing
  res.json({ 
    message: "Video test endpoint - Streaming would work here",
    status: "ok"
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Stremio Overseerr Addon',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  log('ERROR', 'Unhandled error', { error: error.message });
  res.status(500).json({ error: 'Internal Server Error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Start server only if not in Vercel
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    log('INFO', `Server started on port ${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
