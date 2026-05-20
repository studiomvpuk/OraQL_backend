import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ExplanationService {
  private readonly logger = new Logger(ExplanationService.name);

  /**
   * Generate explanation for match result probability
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

    const parts = [
      `${homeName} average ${homeStats.avgGoalsScored.toFixed(2)} goals per match over last 10 games.`,
      `${awayName} average ${awayStats.avgGoalsScored.toFixed(2)} goals per match.`,
    ];

    // Add injury mentions
    if (homeInjuryFactor < 0.95) {
      parts.push(
        `${homeName} have key injuries affecting their expected performance.`,
      );
    }

    if (awayInjuryFactor < 0.95) {
      parts.push(
        `${awayName} have key injuries affecting their expected performance.`,
      );
    }

    // Add home advantage note
    parts.push(`Home advantage factor applied (8%)`);

    // Add possession context if available
    if (homeStats.avgPossession && awayStats.avgPossession) {
      parts.push(
        `${homeName} typically have ${homeStats.avgPossession.toFixed(1)}% possession vs ${awayStats.avgPossession.toFixed(1)}% for ${awayName}.`,
      );
    }

    // Add form context
    const homeWinRate = (homeStats.winRate * 100).toFixed(0);
    const awayWinRate = (awayStats.winRate * 100).toFixed(0);
    parts.push(
      `Recent form: ${homeName} win rate ${homeWinRate}%, ${awayName} win rate ${awayWinRate}%.`,
    );

    return parts.join(' ');
  }

  /**
   * Generate explanation for goals over/under
   */
  explainGoalsOverUnder(
    event: any,
    line: number,
    expectedGoals: number,
    confidence: number,
  ): string {
    const probability = expectedGoals > line ? 'OVER' : 'UNDER';
    const difference = Math.abs(expectedGoals - line).toFixed(2);

    const parts = [
      `Expected total goals: ${expectedGoals.toFixed(2)}`,
      `Line: ${line}`,
      `Expected to go ${probability} by approximately ${difference} goals.`,
    ];

    if (confidence < 0.75) {
      parts.push(
        `Lower confidence due to limited historical data or high volatility.`,
      );
    }

    return parts.join(' ');
  }

  /**
   * Generate explanation for corners over/under
   */
  explainCornersOverUnder(
    event: any,
    line: number,
    expectedCorners: number,
    confidence: number,
  ): string {
    const probability = expectedCorners > line ? 'OVER' : 'UNDER';

    const parts = [
      `Expected corners: ${expectedCorners.toFixed(2)}`,
      `Line: ${line}`,
      `Expected to go ${probability}.`,
    ];

    if (expectedCorners > 9) {
      parts.push(
        `Higher corner count expected due to attacking intent or defensive issues.`,
      );
    }

    if (confidence < 0.75) {
      parts.push(`Corner volatility affects confidence level.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate explanation for cards over/under
   */
  explainCardsOverUnder(
    event: any,
    line: number,
    expectedCards: number,
    confidence: number,
  ): string {
    const probability = expectedCards > line ? 'OVER' : 'UNDER';

    const parts = [
      `Expected yellow/red cards: ${expectedCards.toFixed(2)}`,
      `Line: ${line}`,
      `Expected to go ${probability}.`,
    ];

    // Could add referee card statistics here
    parts.push(`Based on referee history and team discipline records.`);

    if (confidence < 0.7) {
      parts.push(`Limited data affects confidence in this market.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate explanation for BTTS (Both Teams To Score)
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

    const parts = [
      `${homeName} score in ${(homeScoreProb * 100).toFixed(1)}% of matches.`,
      `${awayName} score in ${(awayScoreProb * 100).toFixed(1)}% of matches.`,
      `Combined probability of both scoring: ${(bttsProb * 100).toFixed(1)}%.`,
    ];

    if (homeScoreProb > 0.75 && awayScoreProb > 0.75) {
      parts.push(`Both teams are strong attacking sides with good scoring records.`);
    }

    if (confidence < 0.75) {
      parts.push(`Limited recent matches affect confidence in this probability.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate a generic low-confidence warning
   */
  generateLowConfidenceWarning(reason: string): string {
    return `Low confidence: ${reason}. Probabilities based on limited data.`;
  }

  /**
   * Summarize key factors for a market
   */
  summarizeMarketFactors(
    market: string,
    factors: Record<string, any>,
  ): string {
    const parts: string[] = [];

    switch (market) {
      case 'MATCH_RESULT':
        if (factors.homeAdvantage) {
          parts.push('Home advantage factor applied.');
        }
        if (factors.injuries) {
          parts.push(`Injuries affecting ${factors.injuries}.`);
        }
        if (factors.form) {
          parts.push(`Recent form: ${factors.form}.`);
        }
        break;

      case 'GOALS':
        if (factors.offensiveStrength) {
          parts.push(`Both teams have strong attacking records.`);
        }
        if (factors.defensiveWeakness) {
          parts.push(`Defensive vulnerabilities expected.`);
        }
        break;

      case 'CORNERS':
        if (factors.attackingStyle) {
          parts.push(`Teams favor attacking play style.`);
        }
        break;

      case 'BTTS':
        if (factors.bothmidfield) {
          parts.push(`Both teams have balanced midfield control.`);
        }
        break;
    }

    return parts.join(' ') || 'Standard market conditions.';
  }
}
