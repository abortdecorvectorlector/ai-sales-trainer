// server/sim/simState.js
// Holds internal simulation state (server-side).

import { SimStates } from "./stateMachine.js";

let simState = {
  customerProfile: null,
  state: null,
  flags: null,
  conversationHistory: [],
};

/* ============================================================
   Initialize the simulation with customer profile + base state
   ============================================================ */
export function initializeSimState(customerProfile, trainingConfig = {}) {
  simState.customerProfile = customerProfile;

  simState.state = {
    // High-level state-machine stage (the real “where are we?”)
    simStage: SimStates.INTRO,

    // Training config / knobs
    trainingConfig: {
      difficulty: trainingConfig.difficulty || "normal",
      customerType: trainingConfig.customerType || "mixed",
      forcedObjection: trainingConfig.objection || null,
      product: trainingConfig.product || null,
    },

    // Internal continuous variables (0–1)
    turnCount: 0,
    trust: 0.25,
    objectionResistance: 0.0,
    clarityLevel: 0.5,
    urgencyToDecide: 0.1,
    confusionLevel: 0.3,

    // Persistence tracking
    lastObjection: null,
  };

  // Discrete flags used by the SimStates transitions
  simState.flags = {
    objectionTurns: 0,

    askedForMeterCheck: false,
    meterPermissionSoftYes: false,

    appointmentSoftYes: false,
    appointmentTimeProposed: false,
    appointmentConfirmed: false,
  };

  simState.conversationHistory = [];
}

/* ============================================================
   Get full simulation state
   ============================================================ */
export function getSimState() {
  return simState;
}

export function updateSimState(patch = {}) {
  if (!simState.state) simState.state = {};

  // Support both shapes:
  // updateSimState({ trust: 0.4 })
  // updateSimState({ state: { trust: 0.4 } })
  const next = patch.state && typeof patch.state === "object" ? patch.state : patch;

  simState.state = {
    ...simState.state,
    ...next,
  };
}

/* ============================================================
   Merge update into internal state
   ============================================================ */
export function mergeSimInternalState(partial) {
  if (!partial) return;
  simState.state = {
    ...simState.state,
    ...partial,
  };
}

/* ============================================================
   Merge flags update (optional)
   ============================================================ */
export function mergeFlags(partialFlags) {
  if (!partialFlags) return;
  simState.flags = {
    ...simState.flags,
    ...partialFlags,
  };
}

/* ============================================================
   Log a conversation turn
   ============================================================ */
export function pushConversationTurn(turn) {
  simState.conversationHistory.push({
    role: turn.role, // "rep" | "customer"
    message: turn.message,
    timestamp: Date.now(),
  });

  if (turn.role === "customer") {
    simState.state.turnCount += 1;
  }
}

/* ============================================================
   Reset simulation
   ============================================================ */
export function resetSimState() {
  simState = {
    customerProfile: null,
    state: null,
    flags: null,
    conversationHistory: [],
  };
}
