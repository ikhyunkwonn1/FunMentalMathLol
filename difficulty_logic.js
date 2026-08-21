"use strict";

(function attachDifficulty(globalScope) {
  const RAW_SCORE_MIN = 0.05;
  const RAW_SCORE_MAX = 6.35;
  const DISPLAY_SCORE_MIN = 0.05;
  const DISPLAY_SCORE_MAX = 2.0;
  const DIFFICULTY_COLOR_DARKEN = 0.9;
  const EASY_COLOR = [0x19, 0xd2, 0x7f];
  const MID_COLOR = [0xff, 0xcc, 0x00];
  const HARD_COLOR = [0xff, 0x3b, 0x30];

  const DIFFICULTY_WEIGHTS = {
    base: 0.85,
    operandMagnitude: 0.55,
    answerMagnitude: 0.25,
    threeDigitAnswer: 0.38,
    subtractionExtraLoad: 0.18,
    onesFactScale: 0.24,
    additionCarryBase: 0.68,
    additionCarryOverflow: 0.24,
    subtractionBorrowBase: 1.0,
    subtractionBorrowGap: 0.2,
    tensMutation: 0.58,
    borrowFromRoundTen: 0.2,
    exactEqualityBonus: -0.9,
    onesCancelBonus: -0.3,
    roundOperandBonus: -0.18,
    roundAnswerBonus: -0.2,
    fiveAnchorBonus: -0.17,
    doubleFactBonus: -0.42,
    nearDoubleBonus: -0.2,
    complementBonus: -0.24,
    nearTenShortcut: -0.36,
    sameTensBonus: -0.12,
    neighborOperandsBonus: -0.1,
    closeDistance1To3Bonus: -2.1,
    closeDistance4To5Bonus: -1.65,
    closeDistance6To10Bonus: -1.1,
    roundTopSmallDistanceBonus: -0.7,
    subtractionNeighborBonus: -0.45,
    nearRoundCompensationSmallAnswerBonus: -0.55,
    tenFrameSubtractionBonus: -0.45,
    answerAwkwardnessScale: 0.12,
    fingerprint: 0.075,
  };

  // Placeholder model for x and /: uncalibrated, only rough enough to keep the
  // difficulty readout and its color meaningful. Tune with the +/- model later.
  const MUL_DIV_WEIGHTS = {
    base: 0.9,
    highFactorLoad: 0.16,
    lowFactorLoad: 0.08,
    productMagnitude: 0.004,
    divisionExtraLoad: 0.55,
    easyFactorBonus: -0.8,
    squareBonus: -0.45,
    nearSquareBonus: -0.15,
  };

  const ANSWER_ONES_AWKWARDNESS = {
    0: -0.45,
    1: -0.08,
    2: 0.02,
    3: 0.22,
    4: 0.1,
    5: -0.28,
    6: 0.08,
    7: 0.25,
    8: -0.03,
    9: 0.18,
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(start, end, progress) {
    return start + (end - start) * progress;
  }

  function mixColor(startColor, endColor, progress) {
    const bounded = clamp(progress, 0, 1);
    return startColor.map((channel, index) => Math.round(lerp(channel, endColor[index], bounded)));
  }

  function rgbToHex(color) {
    return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }

  function darkenColor(color, factor) {
    return color.map((channel) => Math.round(channel * factor));
  }

  function mod(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function displayScore(rawScore) {
    const rawSpan = RAW_SCORE_MAX - RAW_SCORE_MIN;
    const displaySpan = DISPLAY_SCORE_MAX - DISPLAY_SCORE_MIN;
    const scaled = DISPLAY_SCORE_MIN + (rawScore - RAW_SCORE_MIN) * (displaySpan / rawSpan);
    return Number(clamp(scaled, DISPLAY_SCORE_MIN, DISPLAY_SCORE_MAX).toFixed(2));
  }

  function singleDigitAddFact(a, b) {
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    let effort = high * 0.5 + low * 0.3;

    if (low === 0) effort -= 2.2;
    if (low === high) effort -= 1.35;
    if ([5, 10, 15].includes(high + low)) effort -= 0.55;
    if (Math.abs(high - low) === 1) effort -= 0.38;

    return Math.max(0.05, effort * DIFFICULTY_WEIGHTS.onesFactScale);
  }

  function singleDigitSubFact(top, bottom) {
    const result = top - bottom;
    let effort = bottom * 0.52 + top * 0.18;

    if (bottom === 0) effort -= 2.0;
    if (result === 0) effort -= 1.6;
    if (result === bottom) effort -= 1.2;
    if ([10, 15, 20].includes(top)) effort -= 0.45;
    if (bottom === 5 || bottom === 10 || result === 5 || result === 10) effort -= 0.35;
    if (bottom === 8 || bottom === 9) effort += 0.22;

    return Math.max(0.05, effort * DIFFICULTY_WEIGHTS.onesFactScale);
  }

  function fingerprintNudge(left, operator, right) {
    const opValue = operator === "+" ? 17 : 31;
    const mixed = (left * 131 + right * 197 + opValue * 53) % 1000;
    const centered = mixed / 999 - 0.5;
    return centered * 2 * DIFFICULTY_WEIGHTS.fingerprint;
  }

  function scoreSubtractionShortcuts(left, right, answer, add) {
    if (answer <= 0) return;

    if (answer <= 3) {
      add(DIFFICULTY_WEIGHTS.closeDistance1To3Bonus);
    } else if (answer <= 5) {
      add(DIFFICULTY_WEIGHTS.closeDistance4To5Bonus);
    } else if (answer <= 10) {
      add(DIFFICULTY_WEIGHTS.closeDistance6To10Bonus);
    }

    if (left % 10 === 0 && answer <= 10) {
      add(DIFFICULTY_WEIGHTS.roundTopSmallDistanceBonus);
    }

    if (answer <= 2) {
      add(DIFFICULTY_WEIGHTS.subtractionNeighborBonus);
    }

    if ((right % 10 === 8 || right % 10 === 9) && answer <= 10) {
      add(DIFFICULTY_WEIGHTS.nearRoundCompensationSmallAnswerBonus);
    }

    if (left === 10 && right >= 5 && right <= 9) {
      add(DIFFICULTY_WEIGHTS.tenFrameSubtractionBonus);
    }
  }

  function scoreSubtraction(left, right, answer, add) {
    const leftOnes = mod(left, 10);
    const rightOnes = mod(right, 10);

    if (rightOnes > leftOnes) {
      const borrowedTop = leftOnes + 10;
      const gap = rightOnes - leftOnes;
      add(singleDigitSubFact(borrowedTop, rightOnes));
      add(DIFFICULTY_WEIGHTS.subtractionBorrowBase + gap * DIFFICULTY_WEIGHTS.subtractionBorrowGap);
      add(DIFFICULTY_WEIGHTS.tensMutation);

      if (leftOnes === 0) {
        add(DIFFICULTY_WEIGHTS.borrowFromRoundTen);
      }

      if (borrowedTop - rightOnes === rightOnes) {
        add(DIFFICULTY_WEIGHTS.doubleFactBonus);
      }

      if (rightOnes === 8 || rightOnes === 9) {
        add(DIFFICULTY_WEIGHTS.nearTenShortcut);
      }
    } else {
      add(singleDigitSubFact(leftOnes, rightOnes));
    }

    if (left === right) {
      add(DIFFICULTY_WEIGHTS.exactEqualityBonus);
    }

    if (leftOnes === rightOnes) {
      add(DIFFICULTY_WEIGHTS.onesCancelBonus);
    }

    if (right % 10 === 8 || right % 10 === 9) {
      const distanceToNextTen = 10 - (right % 10);
      add(DIFFICULTY_WEIGHTS.nearTenShortcut / distanceToNextTen);
    }

    scoreSubtractionShortcuts(left, right, answer, add);
  }

  function scoreAddition(left, right, answer, add) {
    const leftOnes = mod(left, 10);
    const rightOnes = mod(right, 10);
    const onesSum = leftOnes + rightOnes;

    add(singleDigitAddFact(leftOnes, rightOnes));

    if (onesSum >= 10) {
      const overflow = onesSum - 10;
      add(DIFFICULTY_WEIGHTS.additionCarryBase + overflow * DIFFICULTY_WEIGHTS.additionCarryOverflow);
      add(DIFFICULTY_WEIGHTS.tensMutation);
    }

    if (leftOnes === rightOnes && leftOnes !== 0) {
      add(DIFFICULTY_WEIGHTS.doubleFactBonus);
    }

    if (Math.abs(leftOnes - rightOnes) === 1) {
      add(DIFFICULTY_WEIGHTS.nearDoubleBonus);
    }

    if (onesSum === 10) {
      add(DIFFICULTY_WEIGHTS.complementBonus);
    }
  }

  function scoreCommonFluency(left, operator, right, answer, add) {
    [left, right].forEach((value) => {
      if (value % 10 === 0) {
        add(DIFFICULTY_WEIGHTS.roundOperandBonus);
      } else if (value % 5 === 0) {
        add(DIFFICULTY_WEIGHTS.fiveAnchorBonus);
      }
    });

    if (answer % 10 === 0) {
      add(DIFFICULTY_WEIGHTS.roundAnswerBonus);
    } else if (answer % 5 === 0) {
      add(DIFFICULTY_WEIGHTS.fiveAnchorBonus);
    }

    const leftTens = Math.floor(left / 10);
    const rightTens = Math.floor(right / 10);
    if (leftTens === rightTens && left >= 10 && right >= 10) {
      add(DIFFICULTY_WEIGHTS.sameTensBonus);
    }

    if (Math.abs(left - right) === 1) {
      add(DIFFICULTY_WEIGHTS.neighborOperandsBonus);
    }

    const answerOnes = mod(Math.abs(answer), 10);
    add(ANSWER_ONES_AWKWARDNESS[answerOnes] * DIFFICULTY_WEIGHTS.answerAwkwardnessScale);

    if (operator === "+" && (left + right) % 10 === 0) {
      add(DIFFICULTY_WEIGHTS.complementBonus);
    }
  }

  function scoreMulDiv(left, operator, right) {
    const factors = operator === "×" ? [left, right] : [right, left / right];
    const high = Math.max(factors[0], factors[1]);
    const low = Math.min(factors[0], factors[1]);

    let score = MUL_DIV_WEIGHTS.base;
    score += high * MUL_DIV_WEIGHTS.highFactorLoad;
    score += low * MUL_DIV_WEIGHTS.lowFactorLoad;
    score += high * low * MUL_DIV_WEIGHTS.productMagnitude;

    if (operator === "÷") {
      score += MUL_DIV_WEIGHTS.divisionExtraLoad;
    }

    if (low <= 2 || low === 5 || low === 10 || high === 10) {
      score += MUL_DIV_WEIGHTS.easyFactorBonus;
    }

    if (high === low) {
      score += MUL_DIV_WEIGHTS.squareBonus;
    } else if (high - low === 1) {
      score += MUL_DIV_WEIGHTS.nearSquareBonus;
    }

    return Math.max(RAW_SCORE_MIN, score);
  }

  function scoreProblem(left, operator, right) {
    if (operator === "×" || operator === "÷") {
      return displayScore(scoreMulDiv(left, operator, right));
    }

    const answer = operator === "+" ? left + right : left - right;
    const reasons = [];

    const add = (amount) => {
      if (Math.abs(amount) >= 0.005) {
        reasons.push(amount);
      }
    };

    add(DIFFICULTY_WEIGHTS.base);
    add(((left + right) / 200) * DIFFICULTY_WEIGHTS.operandMagnitude);
    add((Math.abs(answer) / 200) * DIFFICULTY_WEIGHTS.answerMagnitude);

    if (Math.abs(answer) >= 100) {
      add(DIFFICULTY_WEIGHTS.threeDigitAnswer);
    }

    if (operator === "-") {
      add(DIFFICULTY_WEIGHTS.subtractionExtraLoad);
      scoreSubtraction(left, right, answer, add);
    } else {
      scoreAddition(left, right, answer, add);
    }

    scoreCommonFluency(left, operator, right, answer, add);
    add(fingerprintNudge(left, operator, right));

    const rawScore = Math.max(
      RAW_SCORE_MIN,
      reasons.reduce((sum, amount) => sum + amount, 0)
    );

    return displayScore(rawScore);
  }

  function formatDifficultyScore(score) {
    return `Difficulty ${score.toFixed(2)}`;
  }

  function getDifficultyColor(score) {
    const normalized = clamp((score - DISPLAY_SCORE_MIN) / (DISPLAY_SCORE_MAX - DISPLAY_SCORE_MIN), 0, 1);
    const baseColor =
      normalized <= 0.5
        ? mixColor(EASY_COLOR, MID_COLOR, normalized / 0.5)
        : mixColor(MID_COLOR, HARD_COLOR, (normalized - 0.5) / 0.5);

    return rgbToHex(darkenColor(baseColor, DIFFICULTY_COLOR_DARKEN));
  }

  globalScope.NumberlineDifficulty = {
    formatDifficultyScore,
    getDifficultyColor,
    scoreProblem,
  };
})(window);
