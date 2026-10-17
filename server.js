
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

const NIM_API_BASE =
  process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';

const NIM_API_KEY = process.env.NIM_API_KEY;
const DEFAULT_MODEL = 'z-ai/glm-5.3';

const MODEL_ALIASES = [
  'z-ai/glm-5.3',
  'glm-5.3',
  'glm',
  'gpt-4',
  'gpt-4o',
  'default'
];

app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI to NVIDIA NIM Proxy',
    version: '3.0-glm-5.3',
    status: 'running',
    default_model: DEFAULT_MODEL,
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NVIDIA NIM GLM-5.3 Proxy',
    nim_api_configured: !!NIM_API_KEY,
    default_model: DEFAULT_MODEL
  });
});

app.get('/v1', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NVIDIA NIM GLM-5.3 Proxy',
    default_model: DEFAULT_MODEL,
    endpoints: ['/v1/models', '/v1/chat/completions']
  });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: DEFAULT_MODEL,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'z-ai'
      },
      ...MODEL_ALIASES
        .filter(id => id !== DEFAULT_MODEL)
        .map(id => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'nvidia-nim-proxy'
        }))
    ]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  if (!NIM_API_KEY) {
    return res.status(500).json({
      error: {
        message: 'NIM_API_KEY is missing from environment variables.',
        type: 'configuration_error'
      }
    });
  }

  const body = req.body || {};

  if (!Array.isArray(body.messages)) {
    return res.status(400).json({
      error: {
        message: 'messages must be an array.',
        type: 'invalid_request_error'
      }
    });
  }

  const requestedModel = body.model || DEFAULT_MODEL;

  const model = MODEL_ALIASES.includes(requestedModel)
    ? DEFAULT_MODEL
    : requestedModel;

  const requestBody = {
    ...body,
    model,
    stream: body.stream === true
  };

  try {
    const upstream = await axios.post(
      `${NIM_API_BASE.replace(/\/+$/, '')}/chat/completions`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: body.stream ? 'text/event-stream' : 'application/json'
        },
        responseType: body.stream ? 'stream' : 'json',
        timeout: 300000,
        validateStatus: () => true
      }
    );

    if (upstream.status < 200 || upstream.status >= 300) {
      let details = upstream.data;

      if (body.stream && upstream.data) {
        details = await new Promise(resolve => {
          let output = '';
          upstream.data.on('data', chunk => {
            output += chunk.toString();
          });
          upstream.data.on('end', () => resolve(output));
          upstream.data.on('error', () => resolve(output));
        });
      }

      console.error('NVIDIA API error:', upstream.status, details);

      return res.status(upstream.status).json({
        error: {
          message: typeof details === 'string'
            ? details
            : details?.detail ||
              details?.error?.message ||
              'NVIDIA API request failed.',
          type: 'nvidia_api_error'
        }
      });
    }

    if (body.stream) {
      res.status(upstream.status);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      upstream.data.on('error', err => {
        console.error('NVIDIA stream error:', err.message);
        if (!res.writableEnded) res.end();
      });

      req.on('close', () => {
        if (!res.writableEnded) upstream.data.destroy();
      });

      upstream.data.pipe(res);
    } else {
      res.status(upstream.status).json(upstream.data);
    }
  } catch (err) {
    console.error('Proxy error:', err.message);

    if (!res.headersSent) {
      res.status(err.response?.status || 502).json({
        error: {
          message: err.code === 'ECONNABORTED'
            ? 'NVIDIA request timed out after 5 minutes.'
            : err.message || 'Could not reach NVIDIA API.',
          type: 'proxy_error'
        }
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Unknown endpoint: ${req.path}`,
      type: 'not_found'
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('NVIDIA NIM Proxy started');
  console.log(`Port: ${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`API key configured: ${!!NIM_API_KEY}`);
});
