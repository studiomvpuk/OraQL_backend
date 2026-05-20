import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OddsData, IDataProvider } from '../interfaces/data-provider.interface';

interface OddsApiResponse {
  success: boolean;
  data?: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    commenceTime: string;
    bookmakers: Array<{
      key: string;
      title: string;
      markets: Array<{
        key: string;
        outcomes: Array<{
          name: string;
          price: number;
        }>;
      }>;
    }>;
  };
}

@Injectable()
export class OddsApiAdapter implements Partial<IDataProvider> {
  private readonly logger = new Logger(OddsApiAdapter.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.the-odds-api.com/v4';
  private readonly maxRequestsPerDay = 500;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('ODDS_API_KEY');
    if (!this.apiKey) {
      throw new Error('ODDS_API_KEY not configured');
    }
  }

  async getOdds(fixtureExternalId: string): Promise<OddsData[]> {
    const url = new URL(`${this.baseUrl}/sports/soccer_epl/events/${fixtureExternalId}/odds`);
    url.searchParams.append('apiKey', this.apiKey);
    url.searchParams.append('regions', 'uk');
    url.searchParams.append('markets', 'h2h,over_under,btts');
    url.searchParams.append('oddsFormat', 'decimal');

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Odds API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data: OddsApiResponse = await response.json();

      if (!data.success || !data.data) {
        this.logger.warn(`No odds data found for fixture ${fixtureExternalId}`);
        return [];
      }

      const odds: OddsData[] = [];

      // Process each bookmaker
      for (const bookmaker of data.data.bookmakers) {
        for (const market of bookmaker.markets) {
          const marketName = this.mapMarketName(market.key);

          for (const outcome of market.outcomes) {
            odds.push({
              bookmaker: bookmaker.title,
              marketName,
              line: this.extractLine(market.key, outcome.name),
              odds: outcome.price,
              impliedProbability: 1 / outcome.price,
            });
          }
        }
      }

      return odds;
    } catch (error) {
      this.logger.error(`Failed to fetch odds for ${fixtureExternalId}:`, error);
      throw error;
    }
  }

  private mapMarketName(apiMarketKey: string): string {
    const marketMap: Record<string, string> = {
      h2h: 'MATCH_RESULT',
      over_under: 'GOALS_OVER_UNDER',
      btts: 'BOTH_TEAMS_TO_SCORE',
      spreads: 'HANDICAP',
      totals: 'TOTAL_GOALS',
    };

    return marketMap[apiMarketKey] || apiMarketKey.toUpperCase();
  }

  private extractLine(marketKey: string, outcomeName: string): number | undefined {
    // Extract line from outcome name for markets like over/under
    if (marketKey === 'over_under') {
      const match = outcomeName.match(/(\d+\.?\d*)/);
      if (match) {
        return parseFloat(match[1]);
      }
    }
    return undefined;
  }
}
