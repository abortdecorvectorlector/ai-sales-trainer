// server/sim/simState.js
// Holds the internal simulation state for the GPT-5.1 homeowner.

let simState = {
  customerProfile: null,
  state: null,
  conversationHistory: [],
};

/* ============================================================
   Initialize the simulation with customer profile + base state
   ============================================================ */
export function initializeSimState(customerProfile) {
  simState.customerProfile = customerProfile;

  simState.state = {
    turnCount: 0,

    // Emotional + Logical Factors
    trust: 0.25,                     // 0–1 scale: starts low
    objectionResistance: 0.0,        // Grows if rep pushes too fast
    clarityLevel: 0.5,               // How well they feel informed
    urgencyToDecide: 0.1,            // Increases when value is shown
    confusionLevel: 0.3,             // Goes up if rep speaks too abstract

    // Key Sales Variables
    interestInProgram: 0.1,          // Rising → closer to yes
    fearOfCostIncrease: 0.7,         // High = money objections
    perceptionOfRisk: customerProfile.personality.riskAversion,
    objectionRepeats: 0,             // How many times same objection came up
    objectionType: null,             // “cost”, “trust”, “moving”, etc.

    // Decision Gates
    readyForMeterCheck: false,
    readyForAppointment: false,

    // Track last objection for persistence detection
    lastObjection: null,
  };

  simState.conversationHistory = [];
}

/* ============================================================
   Get full simulation state
   ============================================================ */
export function getSimState() {
  return simState;
}

/* ============================================================
   Update internal state (merged, not replaced)
   ============================================================ */
export function updateSimState(update) {
  if (update.state) {
    simState.state = {
      ...simState.state,
      ...update.state,
    };
  }
}

/* ============================================================
   Log a conversation turn
   ============================================================ */
export function pushConversationTurn(turn) {
  simState.conversationHistory.push({
    role: turn.role,
    message: turn.message,
    timestamp: Date.now(),
  });

  // Increment turn count only on customer replies
  if (turn.role === "customer") {
    simState.state.turnCount += 1;
  }
}

/* ============================================================
   Reset simulation (if needed)
   ============================================================ */
export function resetSimState() {
  simState = {
    customerProfile: null,
    state: null,
    conversationHistory: [],
  };
}
