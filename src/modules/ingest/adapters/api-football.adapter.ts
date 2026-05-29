import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IDataProvider,
  FixtureData,
  LeagueData,
  TeamData,
  MatchStatsData,
  PlayerData,
  LineupData,
  InjuryData,
  FixtureEventData,
  PlayerMatchStatsData,
  PlayerSeasonStatsData,
} from '../interfaces/data-provider.interface';

interface ApiFootballResponse<T> {
  get: string;
  parameters: Record<string, any>;
  errors: any[];
  results: number;
  paging: {
    current: number;
    total: number;
  };
  response: T[];
}

@Injectable()
export class ApiFootballAdapter implements IDataProvider {
  private readonly logger = new Logger(ApiFootballAdapter.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly useRapidApi: boolean;
  private readonly maxRequestsPerMinute = 30;
  private requestTimestamps: number[] = [];

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('API_FOOTBALL_KEY') || '';
    // Support both direct (api-sports.io) and RapidAPI hosting
    this.useRapidApi = this.configService.get<string>('API_FOOTBALL_HOST') === 'rapidapi';
    this.baseUrl = this.useRapidApi
      ? 'https://api-football-v1.p.rapidapi.com/v3'
      : 'https://v3.football.api-sports.io';
    if (!this.apiKey) {
      this.logger.warn('API_FOOTBALL_KEY not configured — data ingestion will be unavailable');
    } else {
      this.logger.log(`API-Football adapter initialized (${this.useRapidApi ? 'RapidAPI' : 'Direct'})`);
    }
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      throw new Error('API_FOOTBALL_KEY not configured. Set it in environment variables.');
    }
  }

  private async ensureRateLimit(): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => timestamp > oneMinuteAgo,
    );

    // If at limit, wait until oldest request expires
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      const oldestTimestamp = Math.min(...this.requestTimestamps);
      const waitTime = oldestTimestamp + 60000 - now;
      if (waitTime > 0) {
        this.logger.warn(
          `Rate limit approaching. Waiting ${waitTime}ms before next request.`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimestamps.push(now);
  }

  private async makeRequest<T>(
    endpoint: string,
    params: Record<string, any> = {},
  ): Promise<T[]> {
    this.ensureConfigured();
    await this.ensureRateLimit();

    const url = new URL(`${this.baseUrl}/${endpoint}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });

    try {
      const headers: Record<string, string> = this.useRapidApi
        ? {
            'x-rapidapi-key': this.apiKey,
            'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
          }
        : {
            'x-apisports-key': this.apiKey,
          };

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json() as ApiFootballResponse<T>;

      if (data.errors && Object.keys(data.errors).length > 0) {
        this.logger.error(`API errors:`, data.errors);
        throw new Error('API returned errors');
      }

      return data.response || [];
    } catch (error) {
      this.logger.error(`Request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  async getLeagues(sport: string): Promise<LeagueData[]> {
    const data = await this.makeRequest<any>('leagues', {
      type: sport.toLowerCase() === 'football' ? 'league' : sport,
    });

    return data.map((league) => ({
      externalId: String(league.league.id),
      name: league.league.name,
      country: league.country?.name,
      logoUrl: league.league.logo,
      sport: 'football',
    }));
  }

  async getTeams(leagueExternalId: string): Promise<TeamData[]> {
    const data = await this.makeRequest<any>('teams', {
      league: leagueExternalId,
    });

    return data.map((item) => ({
      externalId: String(item.team.id),
      name: item.team.name,
      shortName: item.team.code || item.team.name.substring(0, 3),
      logoUrl: item.team.logo,
    }));
  }

  async getFixtures(
    date: Date,
    leagueExternalIds?: string[],
  ): Promise<FixtureData[]> {
    const dateStr = date.toISOString().split('T')[0];
    const params: Record<string, any> = { date: dateStr };

    if (leagueExternalIds && leagueExternalIds.length > 0) {
      params.league = leagueExternalIds[0];
    }

    const data = await this.makeRequest<any>('fixtures', params);

    return data.map((fixture) => {
      const statusMap: Record<string, FixtureData['status']> = {
        '1H': 'LIVE',
        '2H': 'LIVE',
        HT: 'HALF_TIME',
        FT: 'FINISHED',
        AET: 'FINISHED',
        PEN: 'FINISHED',
        NS: 'SCHEDULED',
        PST: 'POSTPONED',
        CANC: 'CANCELLED',
        SUSP: 'SUSPENDED',
      };

      return {
        externalId: String(fixture.fixture.id),
        leagueExternalId: String(fixture.league.id),
        leagueName: fixture.league.name,
        leagueLogoUrl: fixture.league.logo,
        leagueCountry: fixture.league.country,
        homeTeamExternalId: String(fixture.teams.home.id),
        homeTeamName: fixture.teams.home.name,
        homeTeamLogoUrl: fixture.teams.home.logo,
        awayTeamExternalId: String(fixture.teams.away.id),
        awayTeamName: fixture.teams.away.name,
        awayTeamLogoUrl: fixture.teams.away.logo,
        kickoffAt: new Date(fixture.fixture.date),
        status: statusMap[fixture.fixture.status.short] || 'SCHEDULED',
        venue: fixture.fixture.venue?.name,
        round: fixture.league.round || undefined,
        season: fixture.league.season,
        homeScore: fixture.goals.home,
        awayScore: fixture.goals.away,
      };
    });
  }

  async getMatchStats(fixtureExternalId: string): Promise<MatchStatsData[]> {
    const data = await this.makeRequest<any>('fixtures/statistics', {
      fixture: fixtureExternalId,
    });

    return data.map((stat) => ({
      teamExternalId: String(stat.team.id),
      goals: stat.statistics.find((s: any) => s.type === 'Goals Scored')?.value
        ? parseInt(stat.statistics.find((s: any) => s.type === 'Goals Scored')?.value, 10)
        : 0,
      shotsTotal: stat.statistics.find((s: any) => s.type === 'Total Shots')
        ?.value
        ? parseInt(stat.statistics.find((s: any) => s.type === 'Total Shots')?.value, 10)
        : undefined,
      shotsOnTarget: stat.statistics.find(
        (s: any) => s.type === 'Shots on Goal',
      )?.value
        ? parseInt(
            stat.statistics.find((s: any) => s.type === 'Shots on Goal')
              ?.value,
            10,
          )
        : undefined,
      possession: stat.statistics.find((s: any) => s.type === 'Ball Possession')
        ?.value
        ? parseInt(
            stat.statistics.find((s: any) => s.type === 'Ball Possession')
              ?.value,
            10,
          )
        : undefined,
      corners: stat.statistics.find((s: any) => s.type === 'Corner Kicks')
        ?.value
        ? parseInt(
            stat.statistics.find((s: any) => s.type === 'Corner Kicks')?.value,
            10,
          )
        : 0,
      yellowCards: stat.statistics.find((s: any) => s.type === 'Yellow Cards')
        ?.value
        ? parseInt(
            stat.statistics.find((s: any) => s.type === 'Yellow Cards')?.value,
            10,
          )
        : 0,
      redCards: stat.statistics.find((s: any) => s.type === 'Red Cards')?.value
        ? parseInt(
            stat.statistics.find((s: any) => s.type === 'Red Cards')?.value,
            10,
          )
        : 0,
      fouls: stat.statistics.find((s: any) => s.type === 'Fouls')?.value
        ? parseInt(stat.statistics.find((s: any) => s.type === 'Fouls')?.value, 10)
        : undefined,
      offsides: stat.statistics.find((s: any) => s.type === 'Offsides')?.value
        ? parseInt(
            stat.statistics.find((s: any) => s.type === 'Offsides')?.value,
            10,
          )
        : undefined,
    }));
  }

  async getLineups(fixtureExternalId: string): Promise<LineupData[]> {
    const data = await this.makeRequest<any>('fixtures/lineups', {
      fixture: fixtureExternalId,
    });

    return data.map((lineup) => ({
      teamExternalId: String(lineup.team.id),
      formation: lineup.formation,
      isConfirmed: true,
      players: (lineup.startXI || [])
        .concat(lineup.substitutes || [])
        .map((player: any) => ({
          playerExternalId: String(player.player.id),
          isStarter: (lineup.startXI || []).some(
            (s: any) => s.player.id === player.player.id,
          ),
          position: player.player.pos,
          shirtNumber: player.player.number,
        })),
    }));
  }

  async getInjuries(leagueExternalId: string): Promise<InjuryData[]> {
    const data = await this.makeRequest<any>('injuries', {
      league: leagueExternalId,
    });

    return data
      .filter((item: any) => item.player)
      .map((item: any) => ({
        playerExternalId: String(item.player.id),
        type: item.type,
        severity: this.mapInjurySeverity(item.type),
        description: item.reason,
        startDate: new Date(item.fixture?.date || new Date()),
        expectedReturn: item.fixture?.date
          ? new Date(
              new Date(item.fixture.date).getTime() +
                7 * 24 * 60 * 60 * 1000,
            )
          : undefined,
        isActive: true,
      }));
  }

  async getPlayers(teamExternalId: string): Promise<PlayerData[]> {
    const data = await this.makeRequest<any>('players', {
      team: teamExternalId,
    });

    return data.map((item) => ({
      externalId: String(item.player.id),
      name: item.player.name,
      position: item.player.position,
      number: item.player.number,
      photoUrl: item.player.photo,
      teamExternalId: String(item.statistics[0]?.team.id || teamExternalId),
      dateOfBirth: item.player.birth?.date
        ? new Date(item.player.birth.date)
        : undefined,
      nationality: item.player.nationality,
    }));
  }

  // ==========================================================================
  // PHASE 1: PLAYER-LEVEL DATA METHODS
  // ==========================================================================

  /**
   * Get match events (goals, cards, substitutions) for a fixture.
   * API-Football endpoint: GET /fixtures/events?fixture={id}
   */
  async getFixtureEvents(fixtureExternalId: string): Promise<FixtureEventData[]> {
    const data = await this.makeRequest<any>('fixtures/events', {
      fixture: fixtureExternalId,
    });

    const eventTypeMap: Record<string, FixtureEventData['type']> = {
      Goal: 'GOAL',
      Card: 'YELLOW_CARD', // refined below based on detail
      subst: 'SUBSTITUTION_IN',
    };

    return data
      .filter((evt: any) => evt.player?.id)
      .flatMap((evt: any) => {
        const results: FixtureEventData[] = [];
        const baseType = eventTypeMap[evt.type] || null;
        if (!baseType) return results;

        const teamExtId = String(evt.team.id);
        const playerExtId = String(evt.player.id);
        const minute = evt.time?.elapsed || 0;
        const detail = evt.detail || '';

        if (evt.type === 'Goal') {
          if (detail === 'Own Goal') {
            results.push({
              playerExternalId: playerExtId,
              teamExternalId: teamExtId,
              type: 'OWN_GOAL',
              minute,
              detail,
            });
          } else if (detail === 'Penalty') {
            results.push({
              playerExternalId: playerExtId,
              teamExternalId: teamExtId,
              type: 'PENALTY_SCORED',
              minute,
              detail,
            });
          } else if (detail === 'Missed Penalty') {
            results.push({
              playerExternalId: playerExtId,
              teamExternalId: teamExtId,
              type: 'PENALTY_MISSED',
              minute,
              detail,
            });
          } else {
            results.push({
              playerExternalId: playerExtId,
              teamExternalId: teamExtId,
              type: 'GOAL',
              minute,
              detail,
            });
          }
          // Assist (if present)
          if (evt.assist?.id) {
            results.push({
              playerExternalId: String(evt.assist.id),
              teamExternalId: teamExtId,
              type: 'ASSIST',
              minute,
              detail: `Assist for ${evt.player.name}`,
            });
          }
        } else if (evt.type === 'Card') {
          results.push({
            playerExternalId: playerExtId,
            teamExternalId: teamExtId,
            type: detail === 'Red Card' || detail === 'Second Yellow card' ? 'RED_CARD' : 'YELLOW_CARD',
            minute,
            detail,
          });
        } else if (evt.type === 'subst') {
          // Player coming in
          results.push({
            playerExternalId: playerExtId,
            teamExternalId: teamExtId,
            type: 'SUBSTITUTION_IN',
            minute,
            detail,
          });
          // Player going out (assist field holds the subbed-out player)
          if (evt.assist?.id) {
            results.push({
              playerExternalId: String(evt.assist.id),
              teamExternalId: teamExtId,
              type: 'SUBSTITUTION_OUT',
              minute,
              detail,
            });
          }
        }

        return results;
      });
  }

  /**
   * Get per-player match statistics for a fixture.
   * API-Football endpoint: GET /fixtures/players?fixture={id}
   */
  async getFixturePlayerStats(fixtureExternalId: string): Promise<PlayerMatchStatsData[]> {
    const data = await this.makeRequest<any>('fixtures/players', {
      fixture: fixtureExternalId,
    });

    const results: PlayerMatchStatsData[] = [];

    for (const teamBlock of data) {
      const teamExtId = String(teamBlock.team.id);

      for (const playerEntry of teamBlock.players || []) {
        const stats = playerEntry.statistics?.[0];
        if (!stats || !playerEntry.player?.id) continue;

        const minutesStr = stats.games?.minutes;
        const minutesPlayed = minutesStr ? parseInt(String(minutesStr), 10) : 0;
        if (minutesPlayed === 0) continue; // skip players who didn't feature

        results.push({
          playerExternalId: String(playerEntry.player.id),
          teamExternalId: teamExtId,
          minutesPlayed,
          shotsTotal: this.safeInt(stats.shots?.total),
          shotsOnTarget: this.safeInt(stats.shots?.on),
          passes: this.safeInt(stats.passes?.total),
          passAccuracy: stats.passes?.accuracy ? parseFloat(stats.passes.accuracy) : undefined,
          tackles: this.safeInt(stats.tackles?.total),
          duels: this.safeInt(stats.duels?.total),
          duelsWon: this.safeInt(stats.duels?.won),
          dribbles: this.safeInt(stats.dribbles?.attempts),
          foulsCommitted: this.safeInt(stats.fouls?.committed),
          foulsDrawn: this.safeInt(stats.fouls?.drawn),
          crosses: this.safeInt(stats.passes?.cross),
          rating: stats.games?.rating ? parseFloat(stats.games.rating) : undefined,
        });
      }
    }

    return results;
  }

  /**
   * Get a player's season-level aggregated stats.
   * API-Football endpoint: GET /players?id={id}&season={season}
   * Returns one entry per league the player appeared in.
   */
  async getPlayerSeasonStats(
    playerExternalId: string,
    season: string,
  ): Promise<PlayerSeasonStatsData[]> {
    const data = await this.makeRequest<any>('players', {
      id: playerExternalId,
      season,
    });

    const results: PlayerSeasonStatsData[] = [];

    for (const item of data) {
      for (const stat of item.statistics || []) {
        if (!stat.league?.id || !stat.team?.id) continue;

        results.push({
          playerExternalId: String(item.player.id),
          teamExternalId: String(stat.team.id),
          leagueExternalId: String(stat.league.id),
          season: String(stat.league.season),
          appearances: this.safeInt(stat.games?.appearences) || 0, // API typo: "appearences"
          goals: this.safeInt(stat.goals?.total) || 0,
          assists: this.safeInt(stat.goals?.assists) || 0,
          yellowCards: this.safeInt(stat.cards?.yellow) || 0,
          redCards: this.safeInt(stat.cards?.red) || 0,
          minutesPlayed: this.safeInt(stat.games?.minutes) || 0,
          shotsTotal: this.safeInt(stat.shots?.total),
          shotsOnTarget: this.safeInt(stat.shots?.on),
          passAccuracy: stat.passes?.accuracy ? parseFloat(String(stat.passes.accuracy)) : undefined,
          crosses: this.safeInt(stat.passes?.cross),
          rating: stat.games?.rating ? parseFloat(String(stat.games.rating)) : undefined,
        });
      }
    }

    return results;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private safeInt(value: any): number | undefined {
    if (value === null || value === undefined) return undefined;
    const parsed = parseInt(String(value), 10);
    return isNaN(parsed) ? undefined : parsed;
  }

  private mapInjurySeverity(
    type: string,
  ): 'MINOR' | 'MODERATE' | 'SEVERE' {
    const severeKeywords = ['fracture', 'tear', 'rupture', 'surgery'];
    const moderateKeywords = ['strain', 'sprain', 'contusion'];

    const lowerType = type.toLowerCase();
    if (severeKeywords.some((keyword) => lowerType.includes(keyword))) {
      return 'SEVERE';
    }
    if (moderateKeywords.some((keyword) => lowerType.includes(keyword))) {
      return 'MODERATE';
    }
    return 'MINOR';
  }
}
