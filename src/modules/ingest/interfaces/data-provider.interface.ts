/**
 * Data Provider Interface
 * Abstract interface for all external data sources (API-Football, The Odds API, etc.)
 */

export interface FixtureData {
  externalId: string;
  leagueExternalId: string;
  leagueName?: string;
  leagueLogoUrl?: string;
  leagueCountry?: string;
  homeTeamExternalId: string;
  homeTeamName?: string;
  homeTeamLogoUrl?: string;
  awayTeamExternalId: string;
  awayTeamName?: string;
  awayTeamLogoUrl?: string;
  kickoffAt: Date;
  status: 'SCHEDULED' | 'LIVE' | 'HALF_TIME' | 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'SUSPENDED';
  venue?: string;
  round?: number;
  season?: number;
  homeScore?: number;
  awayScore?: number;
}

export interface TeamData {
  externalId: string;
  name: string;
  shortName?: string;
  logoUrl?: string;
}

export interface LeagueData {
  externalId: string;
  name: string;
  country?: string;
  logoUrl?: string;
  sport: string;
}

export interface MatchStatsData {
  teamExternalId: string;
  goals: number;
  shotsTotal?: number;
  shotsOnTarget?: number;
  possession?: number;
  corners: number;
  yellowCards: number;
  redCards: number;
  fouls?: number;
  offsides?: number;
}

export interface PlayerData {
  externalId: string;
  name: string;
  position?: string;
  number?: number;
  photoUrl?: string;
  teamExternalId: string;
  dateOfBirth?: Date;
  nationality?: string;
}

export interface LineupData {
  teamExternalId: string;
  formation?: string;
  isConfirmed: boolean;
  players: Array<{
    playerExternalId: string;
    isStarter: boolean;
    position?: string;
    shirtNumber?: number;
  }>;
}

export interface InjuryData {
  playerExternalId: string;
  type: string;
  severity?: 'MINOR' | 'MODERATE' | 'SEVERE';
  description?: string;
  startDate: Date;
  expectedReturn?: Date;
  isActive: boolean;
}

export interface OddsData {
  bookmaker: string;
  marketName: string;
  line?: number;
  odds: number;
  impliedProbability: number;
}

// ============================================================================
// PHASE 1: PLAYER-LEVEL DATA INTERFACES
// ============================================================================

export interface FixtureEventData {
  playerExternalId: string;
  teamExternalId: string;
  type: 'GOAL' | 'ASSIST' | 'YELLOW_CARD' | 'RED_CARD' | 'SUBSTITUTION_IN' | 'SUBSTITUTION_OUT' | 'PENALTY_SCORED' | 'PENALTY_MISSED' | 'OWN_GOAL';
  minute: number;
  detail?: string;
}

export interface PlayerMatchStatsData {
  playerExternalId: string;
  teamExternalId: string;
  minutesPlayed: number;
  shotsTotal?: number;
  shotsOnTarget?: number;
  passes?: number;
  passAccuracy?: number;
  tackles?: number;
  duels?: number;
  duelsWon?: number;
  dribbles?: number;
  foulsCommitted?: number;
  foulsDrawn?: number;
  crosses?: number;
  rating?: number;
}

export interface PlayerSeasonStatsData {
  playerExternalId: string;
  teamExternalId: string;
  leagueExternalId: string;
  season: string;
  appearances: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  minutesPlayed: number;
  shotsTotal?: number;
  shotsOnTarget?: number;
  passAccuracy?: number;
  crosses?: number;
  rating?: number;
}

export interface IDataProvider {
  /**
   * Get fixtures for a specific date, optionally filtered by leagues
   */
  getFixtures(date: Date, leagueExternalIds?: string[]): Promise<FixtureData[]>;

  /**
   * Get all leagues for a sport
   */
  getLeagues(sport: string): Promise<LeagueData[]>;

  /**
   * Get all teams in a league
   */
  getTeams(leagueExternalId: string): Promise<TeamData[]>;

  /**
   * Get match statistics for a fixture
   */
  getMatchStats(fixtureExternalId: string): Promise<MatchStatsData[]>;

  /**
   * Get lineup information for a fixture
   */
  getLineups(fixtureExternalId: string): Promise<LineupData[]>;

  /**
   * Get injury information for a league
   */
  getInjuries(leagueExternalId: string): Promise<InjuryData[]>;

  /**
   * Get all players for a team
   */
  getPlayers(teamExternalId: string): Promise<PlayerData[]>;

  /**
   * Get odds for a fixture (optional - only implemented by odds providers)
   */
  getOdds?(fixtureExternalId: string): Promise<OddsData[]>;

  /**
   * Get match events (goals, cards, subs) for a fixture
   */
  getFixtureEvents?(fixtureExternalId: string): Promise<FixtureEventData[]>;

  /**
   * Get per-player match statistics for a fixture
   */
  getFixturePlayerStats?(fixtureExternalId: string): Promise<PlayerMatchStatsData[]>;

  /**
   * Get a player's season-level aggregated stats
   */
  getPlayerSeasonStats?(playerExternalId: string, season: string): Promise<PlayerSeasonStatsData[]>;
}
