const express = require('express');
const fetch = require('node-fetch');
const { base64encode, base64decode } = require('base64url');
const dns = require('dns').promises;

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = 'b9ec03e24520c344670f7a67d5e8c5f9';

// Enhanced logging utility
class Logger {
  static generateId() {
    return Math.random().toString(36).substring(2, 10);
  }

  static log(level, requestId, component, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      requestId,
      component,
      message,
      ...data
    };
    console.log(JSON.stringify(logEntry));
  }

  static info(requestId, component, message, data = {}) {
    this.log('INFO', requestId, component, message, data);
  }

  static error(requestId, component, message, data = {}) {
    this.log('ERROR', requestId, component, message, data);
  }

  static warn(requestId, component, message, data = {}) {
    this.log('WARN', requestId, component, message, data);
  }

  static debug(requestId, component, message, data = {}) {
    this.log('DEBUG', requestId, component, message, data);
  }
}

// Enhanced network diagnostics
class NetworkDiagnostics {
  static async diagnoseHostname(hostname, requestId) {
    try {
      Logger.info(requestId, 'DNS', `Resolving hostname: ${hostname}`);
      const addresses = await dns.resolve4(hostname);
      Logger.info(requestId, 'DNS', `Resolved successfully`, { addresses });
      return { success: true, addresses };
    } catch (error) {
      Logger.error(requestId, 'DNS', `Resolution failed`, {
        hostname,
        error: error.message,
        code: error.code
      });
      return { success: false, error: error.message };
    }
  }

  static async testEndpoint(url, headers = {}, requestId) {
    const startTime = Date.now();
    try {
      Logger.info(requestId, 'NETWORK', `Testing endpoint connectivity`, { url });
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      Logger.info(requestId, 'NETWORK', `Endpoint test completed`, {
        url,
        status: response.status,
        statusText: response.statusText,
        duration: `${duration}ms`,
        ok: response.ok
      });

      return { success: response.ok, status: response.status, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.error(requestId, 'NETWORK', `Endpoint test failed`, {
        url,
        error: error.message,
        duration: `${duration}ms`,
        code: error.code
      });
      return { success: false, error: error.message, duration };
    }
  }
}

// Enhanced Overseerr service with comprehensive logging
class OverseerrService {
  static async checkAvailability(overseerrUrl, apiKey, mediaType, tmdbId, title, requestId) {
    const startTime = Date.now();
    
    Logger.info(requestId, 'OVERSEERR', `Starting availability check`, {
      title,
      tmdbId,
      mediaType,
      overseerrUrl: this.sanitizeUrl(overseerrUrl),
      apiKeyPresent: !!apiKey,
      apiKeyLength: apiKey?.length || 0
    });

    try {
      // Step 1: Network diagnostics
      const url = new URL(overseerrUrl);
      const dnsResult = await NetworkDiagnostics.diagnoseHostname(url.hostname, requestId);
      if (!dnsResult.success) {
        throw new Error(`DNS resolution failed: ${dnsResult.error}`);
      }

      // Step 2: Prepare API request
      const apiUrl = `${overseerrUrl}/api/v1/request?take=10&filter=available`;
      Logger.debug(requestId, 'OVERSEERR', `Preparing API request`, {
        apiUrl: this.sanitizeUrl(apiUrl),
        headers: {
          'X-Api-Key': apiKey ? `${apiKey.substring(0, 8)}...` : 'missing'
        }
      });

      // Step 3: Execute request with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
        Logger.error(requestId, 'OVERSEERR', `Request timeout after 15 seconds`);
      }, 15000);

      const fetchStartTime = Date.now();
      let response;

      try {
        response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'Stremio-Overseerr-Addon/1.0'
          },
          signal: controller.signal
        });
      } catch (fetchError) {
        const fetchDuration = Date.now() - fetchStartTime;
        Logger.error(requestId, 'OVERSEERR', `Fetch failed`, {
          error: fetchError.message,
          code: fetchError.code,
          fetchDuration: `${fetchDuration}ms`
        });
        throw fetchError;
      } finally {
        clearTimeout(timeout);
      }

      const fetchDuration = Date.now() - fetchStartTime;
      
      Logger.debug(requestId, 'OVERSEERR', `Response received`, {
        status: response.status,
        statusText: response.statusText,
        fetchDuration: `${fetchDuration}ms`,
        headers: Object.fromEntries(response.headers.entries())
      });

      // Step 4: Process response
      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
          Logger.error(requestId, 'OVERSEERR', `API error response`, {
            status: response.status,
            body: errorBody.substring(0, 200)
          });
        } catch (textError) {
          Logger.error(requestId, 'OVERSEERR', `Failed to read error body`, {
            error: textError.message
          });
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const totalDuration = Date.now() - startTime;

      const available = data.results?.some(req => req.media?.status === 3) || false;
      const availableCount = data.results?.filter(req => req.media?.status === 3).length || 0;

      Logger.info(requestId, 'OVERSEERR', `Availability check completed`, {
        title,
        tmdbId,
        available,
        availableCount,
        totalRequests: data.results?.length || 0,
        totalDuration: `${totalDuration}ms`
      });

      return {
        available,
        requests: data.results || [],
        availableCount,
        totalCount: data.results?.length || 0
      };

    } catch (error) {
      const totalDuration = Date.now() - startTime;
      Logger.error(requestId, 'OVERSEERR', `Availability check failed`, {
        title,
        tmdbId,
        error: error.message,
        errorType: error.name,
        code: error.code,
        totalDuration: `${totalDuration}ms`
      });
      throw error;
    }
  }

  static sanitizeUrl(url) {
    return url.replace(/(api_key=)[^&]+/, '$1***')
             .replace(/(X-Api-Key=)[^&]+/, '$1***');
  }
}

// TMDB Service
class TMDBService {
  static async convertImdbToTmdb(imdbId, requestId) {
    const startTime = Date.now();
    Logger.info(requestId, 'TMDB', `Converting IMDb to TMDB`, { imdbId });

    try {
      const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
      
      const response = await fetch(url, { timeout: 10000 });
      
      if (!response.ok) {
        throw new Error(`TMDB API returned ${response.status}`);
      }

      const data = await response.json();
      const tmdbId = data.movie_results?.[0]?.id;

      if (!tmdbId) {
        throw new Error(`No TMDB ID found for IMDb ${imdbId}`);
      }

      const duration = Date.now() - startTime;
      Logger.info(requestId, 'TMDB', `Conversion successful`, {
        imdbId,
        tmdbId,
        duration: `${duration}ms`
      });

      return tmdbId;
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.error(requestId, 'TMDB', `Conversion failed`, {
        imdbId,
        error: error.message,
        duration: `${duration}ms`
      });
      throw error;
    }
  }

  static async getMovieDetails(tmdbId, requestId) {
    Logger.debug(requestId, 'TMDB', `Fetching movie details`, { tmdbId });
    
    const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch movie details: ${response.status}`);
    }

    return await response.json();
  }
}

// Configuration management
class ConfigManager {
  static parseConfiguration(configBase64, requestId) {
    try {
      Logger.debug(requestId, 'CONFIG', `Parsing configuration`, {
        configLength: configBase64?.length || 0
      });

      if (!configBase64) {
        throw new Error('No configuration provided');
      }

      const configJson = base64decode(configBase64);
      const config = JSON.parse(configJson);

      Logger.info(requestId, 'CONFIG', `Configuration parsed successfully`, {
        overseerrUrl: config.overseerrUrl,
        hasApiKey: !!config.overseerrApi,
        tmdbKeyPresent: !!config.tmdbKey
      });

      return config;
    } catch (error) {
      Logger.error(requestId, 'CONFIG', `Configuration parsing failed`, {
        error: error.message
      });
      throw error;
    }
  }
}

// Stream handler with enhanced logging
async function handleStreamRequest(id, type, config, requestId) {
  const startTime = Date.now();
  
  Logger.info(requestId, 'STREAM', `Stream request received`, {
    id,
    type,
    config: {
      overseerrUrl: OverseerrService.sanitizeUrl(config.overseerrUrl),
      hasApiKey: !!config.overseerrApi
    }
  });

  try {
    // Step 1: Parse ID
    Logger.debug(requestId, 'STREAM', `Parsing content ID`, { id, type });
    
    // Step 2: Convert IMDb to TMDB
    Logger.info(requestId, 'STREAM', `Converting IMDb to TMDB`, { imdbId: id });
    const tmdbId = await TMDBService.convertImdbToTmdb(id, requestId);

    // Step 3: Get movie details
    const movieDetails = await TMDBService.getMovieDetails(tmdbId, requestId);
    const title = movieDetails.title;
    
    Logger.info(requestId, 'STREAM', `Movie details retrieved`, {
      imdbId: id,
      tmdbId,
      title
    });

    // Step 4: Check Overseerr availability
    Logger.info(requestId, 'STREAM', `Checking Overseerr availability`, {
      title,
      tmdbId
    });

    const availability = await OverseerrService.checkAvailability(
      config.overseerrUrl,
      config.overseerrApi,
      type,
      tmdbId,
      title,
      requestId
    );

    // Step 5: Prepare streams
    const streams = [];
    if (availability.available) {
      streams.push({
        url: `${config.overseerrUrl}/api/v1/media/${tmdbId}`,
        title: `Watch ${title} (Overseerr)`,
        name: 'Overseerr'
      });
    }

    // Add fallback test stream
    streams.push({
      url: `https://stremio-overseerr-addon.vercel.app/video-test`,
      title: `Test Stream for ${title}`,
      name: 'Test Stream'
    });

    const totalDuration = Date.now() - startTime;
    Logger.info(requestId, 'STREAM', `Stream request completed`, {
      id,
      title,
      tmdbId,
      streamCount: streams.length,
      available: availability.available,
      totalDuration: `${totalDuration}ms`
    });

    return { streams };

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    Logger.error(requestId, 'STREAM', `Stream request failed`, {
      id,
      type,
      error: error.message,
      totalDuration: `${totalDuration}ms`
    });

    // Return test stream as fallback
    return {
      streams: [{
        url: `https://stremio-overseerr-addon.vercel.app/video-test`,
        title: `Test Stream (Fallback)`,
        name: 'Test Stream'
      }]
    };
  }
}

// Background request handler
async function handleBackgroundRequest(movieId, title, config, requestId) {
  const startTime = Date.now();
  
  Logger.info(requestId, 'BACKGROUND', `Background job started`, {
    movieId,
    title,
    config: {
      overseerrUrl: OverseerrService.sanitizeUrl(config.overseerrUrl),
      hasApiKey: !!config.overseerrApi
    }
  });

  try {
    // Step 1: Convert IMDb to TMDB
    Logger.info(requestId, 'BACKGROUND', `Converting IMDb ID`, { movieId });
    const tmdbId = await TMDBService.convertImdbToTmdb(movieId, requestId);

    // Step 2: Check availability
    Logger.info(requestId, 'BACKGROUND', `Checking availability`, {
      title,
      tmdbId
    });

    const availability = await OverseerrService.checkAvailability(
      config.overseerrUrl,
      config.overseerrApi,
      'movie',
      tmdbId,
      title,
      requestId
    );

    const totalDuration = Date.now() - startTime;
    Logger.info(requestId, 'BACKGROUND', `Background job completed`, {
      movieId,
      title,
      tmdbId,
      available: availability.available,
      availableCount: availability.availableCount,
      totalDuration: `${totalDuration}ms`
    });

    return {
      success: true,
      available: availability.available,
      tmdbId,
      availableCount: availability.availableCount
    };

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    Logger.error(requestId, 'BACKGROUND', `Background job failed`, {
      movieId,
      title,
      error: error.message,
      totalDuration: `${totalDuration}ms`
    });

    return {
      success: false,
      error: error.message
    };
  }
}

// Configuration test endpoint
async function testConfiguration(overseerrUrl, apiKey, requestId) {
  const startTime = Date.now();
  
  Logger.info(requestId, 'CONFIG_TEST', `Starting configuration test`, {
    overseerrUrl: OverseerrService.sanitizeUrl(overseerrUrl),
    apiKeyPresent: !!apiKey
  });

  try {
    // Step 1: DNS resolution test
    const url = new URL(overseerrUrl);
    const dnsResult = await NetworkDiagnostics.diagnoseHostname(url.hostname, requestId);
    if (!dnsResult.success) {
      throw new Error(`DNS resolution failed: ${dnsResult.result.error}`);
    }

    // Step 2: Endpoint connectivity test
    const testUrl = `${overseerrUrl}/api/v1/user`;
    const endpointResult = await NetworkDiagnostics.testEndpoint(
      testUrl, 
      { 'X-Api-Key': apiKey }, 
      requestId
    );

    if (!endpointResult.success) {
      throw new Error(`Endpoint test failed: ${endpointResult.error}`);
    }

    // Step 3: API functionality test
    const response = await fetch(testUrl, {
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const userData = await response.json();
    const totalDuration = Date.now() - startTime;

    Logger.info(requestId, 'CONFIG_TEST', `Configuration test passed`, {
      user: userData.email,
      permissions: userData.permissions,
      totalDuration: `${totalDuration}ms`
    });

    return {
      success: true,
      user: userData.email,
      permissions: userData.permissions
    };

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    Logger.error(requestId, 'CONFIG_TEST', `Configuration test failed`, {
      error: error.message,
      totalDuration: `${totalDuration}ms`
    });

    return {
      success: false,
      error: error.message
    };
  }
}

// Express Routes

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  const requestId = Logger.generateId();
  Logger.info(requestId, 'MANIFEST', `Manifest requested`);
  
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

// Configured manifest endpoint
app.get('/configured/:config/manifest.json', (req, res) => {
  const requestId = Logger.generateId();
  const config = req.params.config;
  
  Logger.info(requestId, 'MANIFEST', `Configured manifest requested`, {
    configLength: config.length
  });

  try {
    const configData = ConfigManager.parseConfiguration(config, requestId);
    
    Logger.info(requestId, 'MANIFEST', `Sending configured manifest`, {
      overseerrUrl: OverseerrService.sanitizeUrl(configData.overseerrUrl)
    });

    res.json({
      id: "community.overseerr",
      version: "1.0.0",
      name: `Overseerr (${new URL(configData.overseerrUrl).hostname})`,
      description: `Overseerr integration for ${configData.overseerrUrl}`,
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: []
    });

  } catch (error) {
    Logger.error(requestId, 'MANIFEST', `Configured manifest failed`, {
      error: error.message
    });
    res.status(400).json({ error: error.message });
  }
});

// Stream endpoint
app.get('/configured/:config/stream/:type/:id.json', async (req, res) => {
  const requestId = Logger.generateId();
  const { config, type, id } = req.params;

  try {
    Logger.info(requestId, 'STREAM', `Stream request started`, { type, id });
    
    const configData = ConfigManager.parseConfiguration(config, requestId);
    const result = await handleStreamRequest(id, type, configData, requestId);
    
    res.json(result);

  } catch (error) {
    Logger.error(requestId, 'STREAM', `Stream endpoint failed`, {
      type,
      id,
      error: error.message
    });
    
    res.json({ streams: [] });
  }
});

// Configuration test endpoint
app.post('/api/test-configuration', async (req, res) => {
  const requestId = Logger.generateId();
  const { overseerrUrl, apiKey } = req.body;

  Logger.info(requestId, 'CONFIG_TEST', `Configuration test requested`, {
    overseerrUrl: OverseerrService.sanitizeUrl(overseerrUrl),
    apiKeyPresent: !!apiKey
  });

  try {
    const result = await testConfiguration(overseerrUrl, apiKey, requestId);
    res.json(result);
  } catch (error) {
    Logger.error(requestId, 'CONFIG_TEST', `Configuration test endpoint failed`, {
      error: error.message
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Background request endpoint
app.post('/api/background-request', async (req, res) => {
  const requestId = Logger.generateId();
  const { movieId, title, config } = req.body;

  Logger.info(requestId, 'BACKGROUND', `Background request received`, {
    movieId,
    title
  });

  try {
    const result = await handleBackgroundRequest(movieId, title, config, requestId);
    res.json(result);
  } catch (error) {
    Logger.error(requestId, 'BACKGROUND', `Background request endpoint failed`, {
      error: error.message
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Video test endpoint
app.get('/video-test', (req, res) => {
  const requestId = Logger.generateId();
  const range = req.headers.range;
  
  Logger.info(requestId, 'VIDEO', `Video test requested`, { range });

  // Simple video streaming for testing
  if (range) {
    Logger.debug(requestId, 'VIDEO', `Range request processed`, { range });
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });
    res.end();
  } else {
    Logger.debug(requestId, 'VIDEO', `Full video request`);
    res.json({ message: "Video test endpoint" });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Diagnostic endpoint
app.get('/diagnose', async (req, res) => {
  const requestId = Logger.generateId();
  const { url } = req.query;
  
  Logger.info(requestId, 'DIAGNOSE', `Diagnostic request`, { url });

  try {
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    const dnsResult = await NetworkDiagnostics.diagnoseHostname(new URL(url).hostname, requestId);
    const endpointResult = await NetworkDiagnostics.testEndpoint(url, {}, requestId);

    res.json({
      dns: dnsResult,
      endpoint: endpointResult,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    Logger.error(requestId, 'DIAGNOSE', `Diagnostic failed`, { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    component: 'SERVER',
    message: `Stremio Overseerr addon started on port ${PORT}`,
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development'
  }));
});

module.exports = app;
