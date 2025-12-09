// server/sim/generateCustomerProfile.js
// Generates a realistic homeowner profile for the simulator.

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

// Weighted boolean helper
function chance(p) {
  return Math.random() < p;
}

export default function generateCustomerProfile() {
  // INCOME BANDS: determines bill tolerance, risk aversion, objection intensity
  const incomeBand = pick([
    "low",
    "lower-middle",
    "middle",
    "upper-middle",
    "high",
  ]);

  // ESTIMATE CURRENT BILL BASED ON HOME SIZE + INCOME
  const estimatedBill = pick([120, 150, 180, 210, 240, 280, 320]);

  // MAX THEY CAN AFFORD: lower-income → tighter limit
  const targetBillMax =
    incomeBand === "low"
      ? estimatedBill - pick([20, 30, 40])
      : incomeBand === "lower-middle"
      ? estimatedBill - pick([10, 20, 30])
      : estimatedBill - pick([0, 10, 20]);

  const absolutelyCannotExceed =
    targetBillMax + pick([0, 10, 20, 25]); // soft boundary

  // PERSONALITY TRAITS
  const riskAversion = rand(0.4, 0.95); // high → avoids commitments
  const trustInSalespeople = rand(0.2, 0.8);
  const moneyStressLevel =
    incomeBand === "low"
      ? rand(0.7, 0.95)
      : incomeBand === "lower-middle"
      ? rand(0.5, 0.85)
      : rand(0.3, 0.7);

  // How likely they are to OBJECT repeatedly
  const objectionPersistence = rand(0.3, 0.9);

  // Preferences & lifestyle factors
  const timeToMoveMonths = pick([0, 6, 12, 18, 24, 36, 60]);
  const caresAboutEnvironment = chance(0.45);
  const hatesContracts = chance(0.55);
  const valuesOutageProtection = chance(0.65);
  const prefersShortConversations = chance(0.35);

  // DEEPER PERSONALITY DRIVERS (affects GPT-5.1 behavior)
  const decisionDriver = pick([
    "money_savings",
    "avoiding_risk",
    "security_and_outage_protection",
    "long_term_stability",
    "skepticism",
    "speed_and_convenience",
  ]);

  const toneProfile = pick([
    "friendly",
    "neutral",
    "guarded",
    "annoyed",
    "confused",
    "cautious",
  ]);

  return {
    id: `customer_${Date.now()}_${Math.floor(Math.random() * 10000)}`,

    demographics: {
      incomeBand,
      homeType: pick(["single-family", "townhome", "duplex"]),
      householdSize: pick([1, 2, 3, 4, 5]),
      homeownerAgeBracket: pick([
        "25-35",
        "35-45",
        "45-55",
        "55-65",
        "65+",
      ]),
    },

    financials: {
      currentBillEstimate: estimatedBill,
      targetBillMax,
      absolutelyCannotExceed,
      moneyStressLevel,
    },

    personality: {
      riskAversion,
      trustInSalespeople,
      objectionPersistence,
      prefersShortConversations,
      valuesOutageProtection,
      caresAboutEnvironment,
      hatesContracts,
      primaryDecisionDriver: decisionDriver,
      toneProfile,
    },

    preferences: {
      timeToMoveMonths,
      communicationStyle: pick([
        "short_and_direct",
        "detailed_and_careful",
        "skeptical_and_slow",
        "friendly_and_chatty",
      ]),
    },
  };
}
