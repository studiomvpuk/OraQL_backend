import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ExplanationService {
  private readonly logger = new Logger(ExplanationService.name);

  /**
   * Generate plain-language explanation for match result probability.
   * PRD US-4.2: No jargon, caveats highlighted.
   */
  explainMatchResult(
    event: any,
    homeStats: any,
    awayStats: any,
    homeExpectedGoals: number,
    awayExpectedGoals: number,
    homeInjuryFactor: number,
    awayInjuryFactor: number,
  ): string {
    const homeName = event.homeTeam.name;
    const awayName = event.awayTeam.name;

    const parts: string[] = [];

    // Scoring context in plain language
    parts.push(
      `${homeName} have been scoring about ${homeExpectedGoals.toFixed(1)} goals per game recently, while ${awayName} average around ${awayExpectedGoals.toFixed(1)}.`,
    );

    // Home advantage
    parts.push(
      `Playing at home gives ${homeName} an edge — historically, home teams win more often.`,
    );

    // Form context
    const homeWinRate = (homeStats.winRate * 100).toFixed(0);
    const awayWinRate = (awayStats.winRate * 100).toFixed(0);
    if (Number(homeWinRate) > Number(awayWinRate) + 15) {
      parts.push(`${homeName} are in stronger form, winning ${homeWinRate}% of recent matches vs ${awayWinRate}% for ${awayName}.`);
    } else if (Number(awayWinRate) > Number(homeWinRate) + 15) {
      parts.push(`${awayName} are in better form lately, winning ${awayWinRate}% of recent games compared to ${homeWinRate}% for ${homeName}.`);
    } else {
      parts.push(`Both teams are in similar form — ${homeName} at ${homeWinRate}% and ${awayName} at ${awayWinRate}% win rate.`);
    }

    // Caveats — injury warnings
    if (homeInjuryFactor < 0.95) {
      parts.push(`[Caveat] ${homeName} have key players missing through injury, which weakens their lineup.`);
    }
    if (awayInjuryFactor < 0.95) {
      parts.push(`[Caveat] ${awayName} are dealing with injuries to important players.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate plain-language explanation for goals over/under.
   */
  explainGoalsOverUnder(
    event: any,
    line: number,
    expectedGoals: number,
    confidence: number,
  ): string {
    const parts: string[] = [];
    const direction = expectedGoals > line ? 'more' : 'fewer';
    const directionLabel = expectedGoals > line ? 'over' : 'under';

    parts.push(
      `Based on both teams' recent scoring records, we expect around ${expectedGoals.toFixed(1)} total goals in this match.`,
    );

    parts.push(
      `That points to ${direction} than ${line} goals — leaning ${directionLabel}.`,
    );

    if (Math.abs(expectedGoals - line) < 0.3) {
      parts.push(`[Caveat] It's a close call — the expected goals are very near the line, so this could easily go either way.`);
    }

    if (confidence < 0.75) {
      parts.push(`[Caveat] Limited match data means this prediction carries more uncertainty than usual.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate plain-language explanation for corners over/under.
   */
  explainCornersOverUnder(
    event: any,
    line: number,
    expectedCorners: number,
    confidence: number,
  ): string {
    const parts: string[] = [];
    const direction = expectedCorners > line ? 'more' : 'fewer';

    parts.push(
      `We expect about ${expectedCorners.toFixed(1)} corners in this game based on how both teams play.`,
    );

    if (expectedCorners > 10) {
      parts.push(`Both teams tend to create lots of attacking pressure, which typically leads to more corners.`);
    } else if (expectedCorners < 7) {
      parts.push(`These teams don't generate as many corners — expect a more controlled, central game.`);
    }

    parts.push(`That suggests ${direction} than ${line} corners.`);

    if (confidence < 0.75) {
      parts.push(`[Caveat] Corners can be unpredictable. This estimate is less reliable than our goals predictions.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate plain-language explanation for cards over/under.
   */
  explainCardsOverUnder(
    event: any,
    line: number,
    expectedCards: number,
    confidence: number,
  ): string {
    const parts: string[] = [];
    const direction = expectedCards > line ? 'more' : 'fewer';

    parts.push(
      `We expect roughly ${expectedCards.toFixed(1)} cards (yellows + reds) in this match.`,
    );

    if (expectedCards > 5) {
      parts.push(`This looks like a fiery contest — both sides have a history of picking up cards.`);
    }

    parts.push(`That suggests ${direction} than ${line} cards.`);

    if (confidence < 0.7) {
      parts.push(`[Caveat] Card counts depend heavily on the referee and match context, so treat this with extra caution.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate plain-language explanation for BTTS (Both Teams To Score).
   */
  explainBTTS(
    event: any,
    homeScoreProb: number,
    awayScoreProb: number,
    bttsProb: number,
    confidence: number,
  ): string {
    const homeName = event.homeTeam.name;
    const awayName = event.awayTeam.name;

    const parts: string[] = [];

    if (homeScoreProb > 0.8 && awayScoreProb > 0.8) {
      parts.push(`Both ${homeName} and ${awayName} score in the vast majority of their games — this looks likely to be an open match.`);
    } else if (homeScoreProb > 0.6 && awayScoreProb > 0.6) {
      parts.push(`${homeName} and ${awayName} both find the net regularly, so there's a decent chance both score here.`);
    } else {
      parts.push(`One or both teams don't always score — ${homeName} find the net in about ${(homeScoreProb * 100).toFixed(0)}% of games, ${awayName} in about ${(awayScoreProb * 100).toFixed(0)}%.`);
    }

    if (bttsProb < 0.5) {
      parts.push(`[Caveat] Despite the individual records, the combined chance of both scoring is below 50% — one side's defence may hold firm.`);
    }

    if (confidence < 0.75) {
      parts.push(`[Caveat] We have limited recent data for one or both teams, so this estimate is less certain.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate a generic low-confidence warning
   */
  generateLowConfidenceWarning(reason: string): string {
    return `[Caveat] ${reason}. This prediction is based on limited data and carries more uncertainty.`;
  }

  /**
   * Summarize key factors for a market in plain language
   */
  summarizeMarketFactors(
    market: string,
    factors: Record<string, any>,
  ): string {
    const parts: string[] = [];

    switch (market) {
      case 'MATCH_RESULT':
        if (factors.homeAdvantage) {
          parts.push('Home advantage gives the hosts a slight boost.');
        }
        if (factors.injuries) {
          parts.push(`[Caveat] Injuries to key players at ${factors.injuries} may shift the balance.`);
        }
        if (factors.form) {
          parts.push(`Recent form: ${factors.form}.`);
        }
        break;

      case 'GOALS':
        if (factors.offensiveStrength) {
          parts.push('Both teams have been scoring freely in recent games.');
        }
        if (factors.defensiveWeakness) {
          parts.push('Defensive weaknesses on one or both sides could lead to goals.');
        }
        break;

      case 'CORNERS':
        if (factors.attackingStyle) {
          parts.push('Both teams play an attacking style that typically generates more corners.');
        }
        break;

      case 'BTTS':
        if (factors.bothmidfield) {
          parts.push('Balanced midfield battles often lead to chances at both ends.');
        }
        break;
    }

    return parts.join(' ') || 'Based on recent performance and statistical models.';
  }
}
