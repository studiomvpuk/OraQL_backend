import { registerAs } from '@nestjs/config';

export const dataProviderConfig = registerAs('dataProviders', () => ({
  apiFootball: {
    key: process.env.API_FOOTBALL_KEY,
    baseUrl: process.env.API_FOOTBALL_BASE_URL || 'https://api-football-v1.p.rapidapi.com',
  },
  oddsApi: {
    key: process.env.ODDS_API_KEY,
    baseUrl: process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com',
  },
}));
