// Preload: set env vars before any module imports
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.OPENAI_API_KEY = 'sk-test';
