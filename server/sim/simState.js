// server/sim/simState.js
// Per-session simulation state store.
// Fixes cross-device “shared conversation” by isolating state by sessionId.
//
// Backward compatible:
// - If a caller omits sessionId, we default to "default".

function freshSim() {
  return {
    customerProfile: null,
    state: null,
    flags: null,
    conversationHistory: [],
    _meta: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

// sessionId -> sim
const store = new Map();

// Basic TTL cleanup (optional but helpful on long-running instances)
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function normalizeSessionId(sessionId) {
  if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
  return "default";
}

function touch(sim) {
  sim._meta.updatedAt = Date.now();
}

function cleanupIfNeeded() {
  // prune old sessions by TTL, then cap size
  const now = Date.now();

  for (const [sid, sim] of store.entries()) {
    const last = sim?._meta?.updatedAt ?? sim?._meta?.createdAt ?? now;
    if (now - last > SESSION_TTL_MS) {
      store.delete(sid);
    }
  }

  if (store.size <= MAX_SESSIONS) return;

  // If still too big, remove oldest updated
  const entries = Array.from(store.entries()).sort((a, b) => {
    const au = a[1]?._meta?.updatedAt ?? 0;
    const bu = b[1]?._meta?.updatedAt ?? 0;
    return au - bu;
  });

  const excess = store.size - MAX_SESSIONS;
  for (let i = 0; i < excess; i++) {
    store.delete(entries[i][0]);
  }
}

/* ============================================================
   Get sim state (per session)
   ============================================================ */
export function getSimState(sessionId) {
  const sid = normalizeSessionId(sessionId);
  if (!store.has(sid)) {
    store.set(sid, freshSim());
  }
  const sim = store.get(sid);
  touch(sim);
  cleanupIfNeeded();
  return sim;
}

/* ============================================================
   Initialize sim (per session)
   ============================================================ */
export function initializeSimState(sessionIdOrProfile, maybeProfile, maybeTrainingConfig = {}) {
  // Support both call styles:
  // initializeSimState(profile)
  // initializeSimState(sessionId, profile, trainingConfig)
  let sessionId = "default";
  let customerProfile = sessionIdOrProfile;
  let trainingConfig = maybeTrainingConfig;

  if (typeof sessionIdOrProfile === "string") {
    sessionId = normalizeSessionId(sessionIdOrProfile);
    customerProfile = maybeProfile;
    trainingConfig = maybeTrainingConfig || {};
  }

  const sim = getSimState(sessionId);

  sim.customerProfile = customerProfile;

  // If your new SimStates machine needs different structure,
  // you can extend this safely; this file’s job is storage isolation.
  sim.state = {
    turnCount: 0,

    // Emotional + Logical Factors
    trust: 0.25, // 0–1
    objectionResistance: 0.0,
    clarityLevel: 0.5,
    urgencyToDecide: 0.1,
    confusionLevel: 0.3,

    // Key Sales Variables
    interestInProgram: 0.1,
    fearOfCostIncrease: 0.7,
    perceptionOfRisk: customerProfile?.personality?.riskAversion ?? 0.5,
    objectionRepeats: 0,
    objectionType: null,

    // Decision Gates
    readyForMeterCheck: false,
    readyForAppointment: false,

    // Track last objection
    lastObjection: null,

    // Optional: training config passthrough
    trainingConfig: trainingConfig || {},
  };

  // Optional flags for state-machine-driven sims
  sim.flags = sim.flags || {
    objectionTurns: 0,
    askedForMeterCheck: false,
    meterPermissionSoftYes: false,
    appointmentSoftYes: false,
    appointmentTimeProposed: false,
    appointmentConfirmed: false,
  };

  sim.conversationHistory = [];
  touch(sim);
}

/* ============================================================
   Update internal state (merged, not replaced)
   ============================================================ */
export function updateSimState(sessionIdOrUpdate, maybeUpdate) {
  // Support both call styles:
  // updateSimState({ state: {...} })
  // updateSimState(sessionId, { state: {...} })
  let sessionId = "default";
  let update = sessionIdOrUpdate;

  if (typeof sessionIdOrUpdate === "string") {
    sessionId = normalizeSessionId(sessionIdOrUpdate);
    update = maybeUpdate;
  }

  const sim = getSimState(sessionId);
  if (!sim.state) sim.state = {};

  if (update && update.state && typeof update.state === "object") {
    sim.state = {
      ...sim.state,
      ...update.state,
    };
  } else if (update && typeof update === "object") {
    // Allow direct merge: updateSimState({ trust: 0.4 })
    sim.state = {
      ...sim.state,
      ...update,
    };
  }

  if (update && update.flags && typeof update.flags === "object") {
    sim.flags = {
      ...(sim.flags || {}),
      ...update.flags,
    };
  }

  touch(sim);
}

/* ============================================================
   Log a conversation turn
   ============================================================ */
export function pushConversationTurn(sessionIdOrTurn, maybeTurn) {
  // Support both call styles:
  // pushConversationTurn(turn)
  // pushConversationTurn(sessionId, turn)
  let sessionId = "default";
  let turn = sessionIdOrTurn;

  if (typeof sessionIdOrTurn === "string") {
    sessionId = normalizeSessionId(sessionIdOrTurn);
    turn = maybeTurn;
  }

  const sim = getSimState(sessionId);

  sim.conversationHistory.push({
    role: turn.role,
    message: turn.message,
    timestamp: Date.now(),
  });

  if (turn.role === "customer" && sim.state) {
    sim.state.turnCount = (sim.state.turnCount || 0) + 1;
  }

  touch(sim);
}

/* ============================================================
   Reset sim (per session)
   ============================================================ */
export function resetSimState(sessionId) {
  const sid = normalizeSessionId(sessionId);
  store.set(sid, freshSim());
  cleanupIfNeeded();
}
